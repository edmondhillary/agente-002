import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";
import express, { Request, Response } from "express";
import twilio from "twilio";
import { google } from "googleapis";
import { MongoClient, Collection } from "mongodb";
import OpenAI, { toFile } from "openai";
import fetch from "node-fetch";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import {
  consultarDisponibilidad as _consultarDisponibilidad,
  crearReserva            as _crearReserva,
  cancelarReserva         as _cancelarReserva,
  listarProximasReservas  as _listarProximasReservas,
} from "./calendar.service";

// ─────────────────────────────────────────
// CLIENTES
// ─────────────────────────────────────────

const anthropic    = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const openai       = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

// ─────────────────────────────────────────
// MONGODB — historial por usuario
// ─────────────────────────────────────────

let historialCol: Collection;

async function conectarMongo() {
  const mongo = new MongoClient(process.env.MONGODB_URI!);
  await mongo.connect();
  const db = mongo.db(process.env.MONGODB_DB!);
  historialCol = db.collection("historial");
  console.log("✅ MongoDB conectado");
}

async function cargarHistorial(telefono: string): Promise<Anthropic.MessageParam[]> {
  const doc = await historialCol.findOne({ telefono });
  const mensajes: Anthropic.MessageParam[] = doc?.mensajes ?? [];
  return mensajes.filter(m => {
    if (typeof m.content === "string") return true;
    if (Array.isArray(m.content)) {
      return m.content.every(b => b.type === "text");
    }
    return false;
  });
}

async function guardarHistorial(telefono: string, mensajes: Anthropic.MessageParam[]) {
  const MAX = 10; // Suficiente para conversaciones multi-turno de 3-4 mensajes cortos
  const recientes = mensajes.length > MAX ? mensajes.slice(-MAX) : mensajes;
  await historialCol.updateOne(
    { telefono },
    { $set: { telefono, mensajes: recientes, updatedAt: new Date() } },
    { upsert: true }
  );
}

// ─────────────────────────────────────────
// ACCIONES PENDIENTES — confirmación de destructivas
// ─────────────────────────────────────────

interface AccionPendiente {
  tipo:       "cancelar";
  eventoId:   string;
  titulo:     string;
  fecha:      string;
  hora:       string;
}

async function guardarAccionPendiente(telefono: string, accion: AccionPendiente) {
  await historialCol.updateOne(
    { telefono },
    { $set: { accionPendiente: accion } },
    { upsert: true }
  );
}

async function obtenerAccionPendiente(telefono: string): Promise<AccionPendiente | null> {
  const doc = await historialCol.findOne({ telefono });
  return doc?.accionPendiente ?? null;
}

async function limpiarAccionPendiente(telefono: string) {
  await historialCol.updateOne({ telefono }, { $unset: { accionPendiente: "" } });
}

// ─────────────────────────────────────────
// GOOGLE CALENDAR — cliente único reutilizable
// ─────────────────────────────────────────

function getCalendarClient() {
  const auth = new google.auth.GoogleAuth({
    keyFile: process.env.GOOGLE_CREDENTIALS_PATH!,
    scopes: ["https://www.googleapis.com/auth/calendar"],
  });
  return google.calendar({ version: "v3", auth });
}

// ─────────────────────────────────────────
// ERROR WRAPPER — mensajes claros al usuario
// Los errores de Google son técnicos, esto los traduce
// ─────────────────────────────────────────

function mensajeDeError(error: any): string {
  const code = error?.code ?? error?.status;
  if (code === 401) return "❌ Error de autenticación con Google Calendar. Revisá las credenciales.";
  if (code === 403) return "❌ Sin permisos para acceder al calendario. Verificá que la service account tenga acceso.";
  if (code === 404) return "❌ El evento no existe o ya fue eliminado.";
  if (code === 429) return "❌ Demasiadas solicitudes a Google. Intentá en unos segundos.";
  if (code >= 500)  return "❌ Error interno de Google Calendar. Intentá de nuevo.";
  return `❌ Error inesperado: ${error.message}`;
}

// ─────────────────────────────────────────
// TOOLS — usan calendar.service.ts
// El cliente se crea acá y se inyecta al service
// ─────────────────────────────────────────

async function consultarDisponibilidad(fecha: string): Promise<string> {
  try {
    return await _consultarDisponibilidad(getCalendarClient(), process.env.GOOGLE_CALENDAR_ID!, fecha);
  } catch (error: any) {
    return mensajeDeError(error);
  }
}

async function crearReserva(titulo: string, fecha: string, horaInicio: string, horaFin: string, descripcion?: string, forzar: boolean = false): Promise<string> {
  try {
    return await _crearReserva(getCalendarClient(), process.env.GOOGLE_CALENDAR_ID!, titulo, fecha, horaInicio, horaFin, "America/Argentina/Cordoba", descripcion, forzar);
  } catch (error: any) {
    return mensajeDeError(error);
  }
}

async function cancelarReserva(eventoId: string): Promise<string> {
  try {
    return await _cancelarReserva(getCalendarClient(), process.env.GOOGLE_CALENDAR_ID!, eventoId);
  } catch (error: any) {
    return mensajeDeError(error);
  }
}

async function listarProximasReservas(cantidad: number = 5): Promise<string> {
  try {
    return await _listarProximasReservas(getCalendarClient(), process.env.GOOGLE_CALENDAR_ID!, cantidad);
  } catch (error: any) {
    return mensajeDeError(error);
  }
}

// ─────────────────────────────────────────
// AUDIO — transcripción con Whisper
// ─────────────────────────────────────────

async function transcribirAudio(mediaUrl: string): Promise<string> {
  // Descargamos el audio de Twilio — requiere autenticación básica
  const res = await fetch(mediaUrl, {
    headers: {
      Authorization: "Basic " + Buffer.from(
        `${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`
      ).toString("base64"),
    },
  });

  if (!res.ok) throw new Error(`No se pudo descargar el audio: ${res.statusText}`);

  const buffer   = await res.arrayBuffer();
  const tmpPath  = path.join(os.tmpdir(), `audio-${Date.now()}.ogg`);
  fs.writeFileSync(tmpPath, Buffer.from(buffer));

  try {
    const transcripcion = await openai.audio.transcriptions.create({
      model:    "whisper-1",
      file:     await toFile(fs.createReadStream(tmpPath), "audio.ogg", { type: "audio/ogg" }),
      language: "es",
    });
    return transcripcion.text;
  } finally {
    fs.unlinkSync(tmpPath); // limpiamos el archivo temporal siempre
  }
}

// ─────────────────────────────────────────
// IMAGEN — descarga y convierte a base64
// ─────────────────────────────────────────

async function descargarImagenBase64(mediaUrl: string): Promise<{ base64: string; mediaType: string }> {
  const res = await fetch(mediaUrl, {
    headers: {
      Authorization: "Basic " + Buffer.from(
        `${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`
      ).toString("base64"),
    },
  });

  if (!res.ok) throw new Error(`No se pudo descargar la imagen: ${res.statusText}`);

  const buffer    = await res.arrayBuffer();
  const base64    = Buffer.from(buffer).toString("base64");
  const mediaType = res.headers.get("content-type") ?? "image/jpeg";
  return { base64, mediaType };
}

// ─────────────────────────────────────────
// EJECUTOR DE TOOLS
// ─────────────────────────────────────────

async function ejecutarTool(nombre: string, input: Record<string, any>, telefono: string): Promise<string> {
  if (nombre === "consultar_disponibilidad") return await consultarDisponibilidad(input.fecha);
  if (nombre === "crear_reserva")            return await crearReserva(input.titulo, input.fecha, input.hora_inicio, input.hora_fin, input.descripcion, input.forzar ?? false);
  if (nombre === "listar_proximas_reservas") return await listarProximasReservas(input.cantidad ?? 5);

  if (nombre === "cancelar_reserva") {
    // No cancelamos directo — guardamos la acción y pedimos confirmación
    await guardarAccionPendiente(telefono, {
      tipo:     "cancelar",
      eventoId: input.evento_id,
      titulo:   input.titulo ?? "Evento",
      fecha:    input.fecha  ?? "",
      hora:     input.hora   ?? "",
    });
    return `⚠️ Vas a cancelar: *${input.titulo ?? "este evento"}* (ID: ${input.evento_id}).\nRespondé *sí* para confirmar o *no* para cancelar la acción.`;
  }

  return `Tool desconocida: ${nombre}`;
}

// ─────────────────────────────────────────
// EL AGENTE — loop principal
// ─────────────────────────────────────────

async function agente(mensaje: string, telefono: string): Promise<string> {
  console.log(`\n📩 [${telefono}]: ${mensaje}`);

  const mensajes = await cargarHistorial(telefono);
  mensajes.push({ role: "user", content: mensaje });

  const tools: Anthropic.Tool[] = [
    {
      name: "consultar_disponibilidad",
      description: "Consulta los eventos de un día específico en Google Calendar para ver qué horarios están ocupados.",
      input_schema: {
        type: "object",
        properties: {
          fecha: { type: "string", description: "Fecha en formato YYYY-MM-DD, ej: 2026-03-27" }
        },
        required: ["fecha"]
      }
    },
    {
      name: "crear_reserva",
      description: "Crea un nuevo evento en Google Calendar. Usala para confirmar una reserva o cita.",
      input_schema: {
        type: "object",
        properties: {
          titulo:      { type: "string", description: "Título del evento, ej: Reunión con Juan" },
          fecha:       { type: "string", description: "Fecha en formato YYYY-MM-DD" },
          hora_inicio: { type: "string", description: "Hora de inicio en formato HH:MM, ej: 14:30" },
          hora_fin:    { type: "string", description: "Hora de fin en formato HH:MM, ej: 15:30" },
          descripcion: { type: "string", description: "Descripción opcional del evento" },
          forzar:      { type: "boolean", description: "Si es true, crea el evento aunque haya conflictos. Usalo solo si el usuario dijo explícitamente que quiere crearlo igual." }
        },
        required: ["titulo", "fecha", "hora_inicio", "hora_fin"]
      }
    },
    {
      name: "cancelar_reserva",
      description: "Cancela (elimina) un evento de Google Calendar usando su ID.",
      input_schema: {
        type: "object",
        properties: {
          evento_id: { type: "string", description: "El ID del evento a cancelar" },
          titulo:    { type: "string", description: "Título del evento, para mostrarle al usuario en la confirmación" },
          fecha:     { type: "string", description: "Fecha del evento en formato YYYY-MM-DD" },
          hora:      { type: "string", description: "Hora del evento, ej: 15:00" }
        },
        required: ["evento_id"]
      }
    },
    {
      name: "listar_proximas_reservas",
      description: "Lista los próximos eventos del calendario. Usala cuando el usuario quiera ver sus reservas.",
      input_schema: {
        type: "object",
        properties: {
          cantidad: { type: "number", description: "Cantidad de eventos a mostrar, por defecto 5" }
        },
        required: []
      }
    }
  ];

  while (true) {
    const respuesta = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 1024,
      tools,
      tool_choice: { type: "auto" },
      messages: mensajes,
      system: `Sos un asistente de agenda personal. Hoy es ${new Date().toLocaleDateString("es-AR", { weekday: "long", year: "numeric", month: "long", day: "numeric" })} (${new Date().toISOString().split("T")[0]}).

REGLAS ESTRICTAS — NUNCA las rompas:
1. Si el usuario no te dio toda la info necesaria para ejecutar una acción, PREGUNTÁ lo que falta antes de llamar a cualquier tool. No inventes datos.
2. Para crear un evento necesitás obligatoriamente: título, fecha, hora de inicio y hora de fin. Si falta alguno, preguntá.
3. NUNCA confirmes que creaste, cancelaste o consultaste algo sin antes llamar a la tool correspondiente.
4. Cuando el usuario mencione fechas relativas como "mañana", "el lunes", calculá la fecha exacta en formato YYYY-MM-DD usando el día de hoy como referencia.
5. Al listar eventos, SIEMPRE mostrá el ID de cada evento entre paréntesis, ej: "- Reunión con Juan (ID: abc123)".
6. Si una tool devuelve un error, informáselo al usuario con el mensaje exacto. NUNCA inventes que algo se creó o canceló si la tool devolvió un error.
7. Cuando crees un evento, confirmá con los datos EXACTOS que devolvió la tool: título, fecha, hora de inicio, hora de fin y el link.`,
    });

    if (respuesta.stop_reason === "tool_use") {
      const toolCall = respuesta.content.find(b => b.type === "tool_use");
      if (!toolCall || toolCall.type !== "tool_use") break;

      console.log(`[Tool]: ${toolCall.name}`, toolCall.input);
      const resultado = await ejecutarTool(toolCall.name, toolCall.input as Record<string, any>, telefono);
      console.log(`[Resultado]: ${resultado}`);

      // Para operaciones que modifican datos, devolvemos el resultado de Google
      // directamente sin que Claude lo reinterprete — así no puede alucinar
      const toolsDeAccion = ["crear_reserva", "cancelar_reserva"];
      if (toolsDeAccion.includes(toolCall.name)) {
        await guardarHistorial(telefono, mensajes);
        return resultado;
      }

      mensajes.push(
        { role: "assistant", content: respuesta.content },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: toolCall.id, content: resultado }]
        }
      );
    } else {
      const textoFinal = respuesta.content.find(b => b.type === "text");
      if (textoFinal && textoFinal.type === "text") {
        const limpios = mensajes.filter(m => {
          if (typeof m.content === "string") return true;
          if (Array.isArray(m.content)) {
            return m.content.every(b => b.type === "text" || b.type === "tool_result");
          }
          return false;
        });
        limpios.push({ role: "assistant", content: textoFinal.text });
        await guardarHistorial(telefono, limpios);
        return textoFinal.text;
      }
      break;
    }
  }

  return "No pude procesar tu mensaje. Intentá de nuevo.";
}

// ─────────────────────────────────────────
// EXPRESS — servidor webhook para Twilio
// ─────────────────────────────────────────

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

app.post("/webhook", async (req: Request, res: Response) => {
  const telefono = req.body.From as string;  // ej: "whatsapp:+5491112345678"
  const mensaje  = req.body.Body as string;

  console.log(`\n🔔 Webhook recibido de ${telefono}: "${mensaje}"`);

  res.set("Content-Type", "text/xml");
  res.send("<Response></Response>");

  // Comando especial para borrar historial
  if (mensaje?.trim() === "/olvida") {
    await historialCol.deleteOne({ telefono });
    await twilioClient.messages.create({
      from: process.env.TWILIO_WHATSAPP_FROM!,
      to: telefono,
      body: "🗑️ Historial borrado. Empezamos de cero.",
    });
    return;
  }

  // ── Confirmación de acción pendiente ──────────────────
  const accion = await obtenerAccionPendiente(telefono);
  if (accion) {
    const respuesta = mensaje?.trim().toLowerCase();
    await limpiarAccionPendiente(telefono);

    if (respuesta === "sí" || respuesta === "si" || respuesta === "s") {
      const resultado = await cancelarReserva(accion.eventoId);
      await twilioClient.messages.create({
        from: process.env.TWILIO_WHATSAPP_FROM!,
        to: telefono,
        body: resultado,
      });
    } else {
      await twilioClient.messages.create({
        from: process.env.TWILIO_WHATSAPP_FROM!,
        to: telefono,
        body: "✅ Cancelación abortada. No se eliminó nada.",
      });
    }
    return;
  }

  const numMedia   = parseInt(req.body.NumMedia ?? "0");
  const mediaUrl   = req.body.MediaUrl0 as string | undefined;
  const mediaType  = req.body.MediaContentType0 as string | undefined;

  try {
    let mensajeParaAgente = mensaje;

    // ── AUDIO ──────────────────────────────
    if (numMedia > 0 && mediaType?.startsWith("audio/")) {
      console.log(`🎙️ Audio recibido — transcribiendo...`);
      await twilioClient.messages.create({
        from: process.env.TWILIO_WHATSAPP_FROM!,
        to: telefono,
        body: "🎙️ Escuché tu audio, transcribiendo...",
      });
      mensajeParaAgente = await transcribirAudio(mediaUrl!);
      console.log(`[Transcripción]: ${mensajeParaAgente}`);
    }

    // ── IMAGEN ─────────────────────────────
    if (numMedia > 0 && mediaType?.startsWith("image/")) {
      console.log(`🖼️ Imagen recibida — analizando...`);
      await twilioClient.messages.create({
        from: process.env.TWILIO_WHATSAPP_FROM!,
        to: telefono,
        body: "🖼️ Recibí tu imagen, analizando...",
      });

      const { base64, mediaType: tipo } = await descargarImagenBase64(mediaUrl!);
      const caption = mensaje ?? "¿Qué ves en esta imagen? Describila en detalle.";

      // Claude Vision — mandamos la imagen como contenido multimodal
      const visionRes = await anthropic.messages.create({
        model: "claude-sonnet-4-6",
        max_tokens: 1024,
        messages: [{
          role: "user",
          content: [
            {
              type: "image",
              source: { type: "base64", media_type: tipo as any, data: base64 },
            },
            { type: "text", text: caption },
          ],
        }],
      });

      const descripcion = visionRes.content.find(b => b.type === "text");
      const respuesta   = descripcion?.type === "text" ? descripcion.text : "No pude analizar la imagen.";

      await twilioClient.messages.create({
        from: process.env.TWILIO_WHATSAPP_FROM!,
        to: telefono,
        body: respuesta,
      });
      console.log(`✅ Imagen analizada y respuesta enviada`);
      return;
    }

    // ── TEXTO O AUDIO TRANSCRIPTO ──────────
    const respuesta = await agente(mensajeParaAgente, telefono);
    await twilioClient.messages.create({
      from: process.env.TWILIO_WHATSAPP_FROM!,
      to: telefono,
      body: respuesta,
    });
    console.log(`✅ Respuesta enviada a ${telefono}`);

  } catch (error: any) {
    console.error("Error procesando mensaje:", error.message);
    await historialCol.deleteOne({ telefono });
    await twilioClient.messages.create({
      from: process.env.TWILIO_WHATSAPP_FROM!,
      to: telefono,
      body: "⚠️ Algo salió mal. Limpié el historial automáticamente. Podés volver a intentarlo.",
    });
  }
});

app.get("/", (_req, res) => {
  res.send("Agente-002 corriendo ✅");
});

// ─────────────────────────────────────────
// ARRANQUE
// ─────────────────────────────────────────

const PORT = process.env.PORT ?? 3000;

conectarMongo().then(() => {
  app.listen(PORT, () => {
    console.log(`🤖 Agente-002 escuchando en http://localhost:${PORT}`);
    console.log(`📡 Webhook disponible en http://localhost:${PORT}/webhook`);
  });
});
