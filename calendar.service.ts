import { calendar_v3 } from "googleapis";

// El cliente se inyecta desde afuera — esto hace el módulo testeable
// En index.ts se pasa getCalendarClient(), en tests se pasa un mock
export type CalendarClient = calendar_v3.Calendar;

export interface CalendarEvent {
  id:        string;
  titulo:    string;
  inicio:    string;
  fin:       string;
  htmlLink:  string;
}

// ─────────────────────────────────────────
// consultarDisponibilidad
// ─────────────────────────────────────────

export async function consultarDisponibilidad(
  client: CalendarClient,
  calendarId: string,
  fecha: string
): Promise<string> {
  const inicio = new Date(`${fecha}T00:00:00`);
  const fin    = new Date(`${fecha}T23:59:59`);

  const res = await client.events.list({
    calendarId,
    timeMin: inicio.toISOString(),
    timeMax: fin.toISOString(),
    singleEvents: true,
    orderBy: "startTime",
  });

  const eventos = res.data.items ?? [];
  if (eventos.length === 0) return `No hay eventos el ${fecha}. El día está libre.`;

  const lista = eventos.map(e => {
    const hora = e.start?.dateTime
      ? new Date(e.start.dateTime).toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit" })
      : "todo el día";
    return `- ${hora}: ${e.summary ?? "Sin título"} (ID: ${e.id})`;
  }).join("\n");

  return `Eventos el ${fecha}:\n${lista}`;
}

// ─────────────────────────────────────────
// crearReserva
// ─────────────────────────────────────────

export async function crearReserva(
  client: CalendarClient,
  calendarId: string,
  titulo: string,
  fecha: string,
  horaInicio: string,
  horaFin: string,
  timezone: string,
  descripcion?: string,
  forzar: boolean = false
): Promise<string> {
  // Validación previa — no llamamos a Google si los datos son inválidos
  if (!titulo.trim())        throw new Error("El título no puede estar vacío");
  if (!fecha.match(/^\d{4}-\d{2}-\d{2}$/)) throw new Error(`Fecha inválida: ${fecha}`);
  if (!horaInicio.match(/^\d{2}:\d{2}$/))  throw new Error(`Hora de inicio inválida: ${horaInicio}`);
  if (!horaFin.match(/^\d{2}:\d{2}$/))     throw new Error(`Hora de fin inválida: ${horaFin}`);

  const startISO = new Date(`${fecha}T${horaInicio}:00`);
  const endISO   = new Date(`${fecha}T${horaFin}:00`);

  if (endISO <= startISO) throw new Error("La hora de fin debe ser posterior a la hora de inicio");

  // ── Verificación de conflictos ──────────────────────────
  // Consultamos si hay eventos que se solapan con el horario pedido
  if (!forzar) {
    const conflictos = await client.events.list({
      calendarId,
      timeMin: startISO.toISOString(),
      timeMax: endISO.toISOString(),
      singleEvents: true,
    });

    const solapados = conflictos.data.items ?? [];
    if (solapados.length > 0) {
      const lista = solapados.map(e => {
        const hora = e.start?.dateTime
          ? new Date(e.start.dateTime).toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit" })
          : "todo el día";
        return `- ${hora}: ${e.summary ?? "Sin título"}`;
      }).join("\n");

      return `⚠️ Ya tenés eventos en ese horario:\n${lista}\n\n¿Querés crearlo igual? Si es así, decime "crealo igual" y lo agendo.`;
    }
  }

  const res = await client.events.insert({
    calendarId,
    requestBody: {
      summary:     titulo,
      description: descripcion ?? "",
      start: { dateTime: `${fecha}T${horaInicio}:00`, timeZone: timezone },
      end:   { dateTime: `${fecha}T${horaFin}:00`,   timeZone: timezone },
    },
  });

  const evento = res.data;
  return `✅ Reserva creada: "${evento.summary}" el ${fecha} de ${horaInicio} a ${horaFin}. ID: ${evento.id}\nVer en Google Calendar: ${evento.htmlLink}`;
}

// ─────────────────────────────────────────
// cancelarReserva
// ─────────────────────────────────────────

export async function cancelarReserva(
  client: CalendarClient,
  calendarId: string,
  eventoId: string
): Promise<string> {
  if (!eventoId.trim()) throw new Error("El ID del evento no puede estar vacío");

  await client.events.delete({ calendarId, eventId: eventoId });
  return `✅ Reserva cancelada correctamente.`;
}

// ─────────────────────────────────────────
// listarProximasReservas
// ─────────────────────────────────────────

export async function listarProximasReservas(
  client: CalendarClient,
  calendarId: string,
  cantidad: number = 5
): Promise<string> {
  const res = await client.events.list({
    calendarId,
    timeMin: new Date().toISOString(),
    maxResults: cantidad,
    singleEvents: true,
    orderBy: "startTime",
  });

  const eventos = res.data.items ?? [];
  if (eventos.length === 0) return "No tenés próximas reservas.";

  const lista = eventos.map(e => {
    const fecha = e.start?.dateTime
      ? new Date(e.start.dateTime).toLocaleString("es-AR", {
          day: "2-digit", month: "2-digit", year: "numeric",
          hour: "2-digit", minute: "2-digit"
        })
      : "todo el día";
    return `- ${fecha}: ${e.summary ?? "Sin título"} (ID: ${e.id})`;
  }).join("\n");

  return `Próximas reservas:\n${lista}`;
}
