import {
  consultarDisponibilidad,
  crearReserva,
  cancelarReserva,
  listarProximasReservas,
  CalendarClient,
} from "./calendar.service";

// ─────────────────────────────────────────
// HELPERS — factory de mocks reutilizables
// ─────────────────────────────────────────

function makeClient(overrides: Partial<any> = {}): CalendarClient {
  return {
    events: {
      list:   jest.fn(),
      insert: jest.fn(),
      delete: jest.fn(),
      ...overrides,
    },
  } as unknown as CalendarClient;
}

function makeGoogleEvent(overrides: Partial<any> = {}) {
  return {
    id:      "event-123",
    summary: "Reunión con Juan",
    start:   { dateTime: "2026-03-31T10:00:00-03:00" },
    end:     { dateTime: "2026-03-31T11:00:00-03:00" },
    htmlLink: "https://calendar.google.com/event?eid=abc",
    ...overrides,
  };
}

const CALENDAR_ID = "test@gmail.com";
const TIMEZONE    = "America/Argentina/Cordoba";

// ─────────────────────────────────────────
// D. CÓDIGO DE TESTS
// ─────────────────────────────────────────

// ══════════════════════════════════════════
// consultarDisponibilidad
// ══════════════════════════════════════════

describe("consultarDisponibilidad", () => {
  describe("caso exitoso", () => {
    it("devuelve mensaje de día libre cuando no hay eventos", async () => {
      // Arrange
      const client = makeClient();
      (client.events.list as jest.Mock).mockResolvedValue({ data: { items: [] } });

      // Act
      const result = await consultarDisponibilidad(client, CALENDAR_ID, "2026-03-31");

      // Assert
      expect(result).toContain("El día está libre");
      expect(result).toContain("2026-03-31");
    });

    it("lista los eventos del día con hora e ID", async () => {
      // Arrange
      const client = makeClient();
      (client.events.list as jest.Mock).mockResolvedValue({
        data: { items: [makeGoogleEvent()] }
      });

      // Act
      const result = await consultarDisponibilidad(client, CALENDAR_ID, "2026-03-31");

      // Assert
      expect(result).toContain("Reunión con Juan");
      expect(result).toContain("event-123");
    });

    it("muestra 'todo el día' para eventos allDay sin dateTime", async () => {
      // Arrange
      const client = makeClient();
      (client.events.list as jest.Mock).mockResolvedValue({
        data: { items: [makeGoogleEvent({ start: { date: "2026-03-31" }, end: { date: "2026-03-31" } })] }
      });

      // Act
      const result = await consultarDisponibilidad(client, CALENDAR_ID, "2026-03-31");

      // Assert
      expect(result).toContain("todo el día");
    });

    it("usa 'Sin título' cuando el evento no tiene summary", async () => {
      // Arrange
      const client = makeClient();
      (client.events.list as jest.Mock).mockResolvedValue({
        data: { items: [makeGoogleEvent({ summary: undefined })] }
      });

      // Act
      const result = await consultarDisponibilidad(client, CALENDAR_ID, "2026-03-31");

      // Assert
      expect(result).toContain("Sin título");
    });

    it("maneja respuesta sin campo items (respuesta incompleta de Google)", async () => {
      // Arrange — Google a veces omite items en lugar de mandar []
      const client = makeClient();
      (client.events.list as jest.Mock).mockResolvedValue({ data: {} });

      // Act
      const result = await consultarDisponibilidad(client, CALENDAR_ID, "2026-03-31");

      // Assert — no debe explotar, debe tratar como día libre
      expect(result).toContain("El día está libre");
    });
  });

  describe("errores del proveedor", () => {
    it("propaga error 401 (token expirado)", async () => {
      const client = makeClient();
      (client.events.list as jest.Mock).mockRejectedValue(
        Object.assign(new Error("Invalid Credentials"), { code: 401 })
      );

      await expect(
        consultarDisponibilidad(client, CALENDAR_ID, "2026-03-31")
      ).rejects.toThrow("Invalid Credentials");
    });

    it("propaga error 403 (sin permisos sobre el calendario)", async () => {
      const client = makeClient();
      (client.events.list as jest.Mock).mockRejectedValue(
        Object.assign(new Error("Forbidden"), { code: 403 })
      );

      await expect(
        consultarDisponibilidad(client, CALENDAR_ID, "2026-03-31")
      ).rejects.toThrow("Forbidden");
    });

    it("propaga error 500 (fallo interno de Google)", async () => {
      const client = makeClient();
      (client.events.list as jest.Mock).mockRejectedValue(new Error("Internal Server Error"));

      await expect(
        consultarDisponibilidad(client, CALENDAR_ID, "2026-03-31")
      ).rejects.toThrow("Internal Server Error");
    });
  });

  describe("llamada a la API", () => {
    it("llama a events.list con el rango correcto del día completo", async () => {
      const client = makeClient();
      (client.events.list as jest.Mock).mockResolvedValue({ data: { items: [] } });

      await consultarDisponibilidad(client, CALENDAR_ID, "2026-03-31");

      expect(client.events.list).toHaveBeenCalledWith(
        expect.objectContaining({
          calendarId:    CALENDAR_ID,
          singleEvents:  true,
          orderBy:       "startTime",
        })
      );
    });
  });
});

// ══════════════════════════════════════════
// crearReserva
// ══════════════════════════════════════════

describe("crearReserva", () => {
  describe("caso exitoso", () => {
    it("crea el evento y devuelve confirmación con datos reales de Google", async () => {
      // Arrange
      const client = makeClient();
      (client.events.insert as jest.Mock).mockResolvedValue({ data: makeGoogleEvent() });

      // Act
      const result = await crearReserva(
        client, CALENDAR_ID,
        "Reunión con Juan", "2026-03-31", "10:00", "11:00", TIMEZONE
      );

      // Assert — los datos vienen de Google, no inventados
      expect(result).toContain("Reunión con Juan");
      expect(result).toContain("event-123");
      expect(result).toContain("https://calendar.google.com/event?eid=abc");
    });

    it("llama a events.insert con la estructura correcta", async () => {
      const client = makeClient();
      (client.events.insert as jest.Mock).mockResolvedValue({ data: makeGoogleEvent() });

      await crearReserva(
        client, CALENDAR_ID,
        "Reunión con Juan", "2026-03-31", "10:00", "11:00", TIMEZONE, "Descripción"
      );

      expect(client.events.insert).toHaveBeenCalledWith({
        calendarId: CALENDAR_ID,
        requestBody: {
          summary:     "Reunión con Juan",
          description: "Descripción",
          start: { dateTime: "2026-03-31T10:00:00", timeZone: TIMEZONE },
          end:   { dateTime: "2026-03-31T11:00:00", timeZone: TIMEZONE },
        },
      });
    });

    it("usa descripción vacía si no se pasa", async () => {
      const client = makeClient();
      (client.events.insert as jest.Mock).mockResolvedValue({ data: makeGoogleEvent() });

      await crearReserva(
        client, CALENDAR_ID,
        "Reunión", "2026-03-31", "10:00", "11:00", TIMEZONE
      );

      expect(client.events.insert).toHaveBeenCalledWith(
        expect.objectContaining({
          requestBody: expect.objectContaining({ description: "" })
        })
      );
    });
  });

  describe("validaciones previas a llamar a Google", () => {
    it("lanza error si el título está vacío", async () => {
      const client = makeClient();

      await expect(
        crearReserva(client, CALENDAR_ID, "", "2026-03-31", "10:00", "11:00", TIMEZONE)
      ).rejects.toThrow("El título no puede estar vacío");

      // Google NO debe ser llamado
      expect(client.events.insert).not.toHaveBeenCalled();
    });

    it("lanza error si el título es solo espacios", async () => {
      const client = makeClient();

      await expect(
        crearReserva(client, CALENDAR_ID, "   ", "2026-03-31", "10:00", "11:00", TIMEZONE)
      ).rejects.toThrow("El título no puede estar vacío");
    });

    it("lanza error si la fecha tiene formato inválido", async () => {
      const client = makeClient();

      await expect(
        crearReserva(client, CALENDAR_ID, "Reunión", "31-03-2026", "10:00", "11:00", TIMEZONE)
      ).rejects.toThrow("Fecha inválida");

      expect(client.events.insert).not.toHaveBeenCalled();
    });

    it("lanza error si hora de inicio tiene formato inválido", async () => {
      const client = makeClient();

      await expect(
        crearReserva(client, CALENDAR_ID, "Reunión", "2026-03-31", "10AM", "11:00", TIMEZONE)
      ).rejects.toThrow("Hora de inicio inválida");
    });

    it("lanza error si hora de fin es anterior a hora de inicio — mismo día", async () => {
      const client = makeClient();

      await expect(
        crearReserva(client, CALENDAR_ID, "Reunión", "2026-03-31", "15:00", "10:00", TIMEZONE)
      ).rejects.toThrow("La hora de fin debe ser posterior");

      expect(client.events.insert).not.toHaveBeenCalled();
    });

    it("lanza error si hora de fin es igual a hora de inicio", async () => {
      const client = makeClient();

      await expect(
        crearReserva(client, CALENDAR_ID, "Reunión", "2026-03-31", "10:00", "10:00", TIMEZONE)
      ).rejects.toThrow("La hora de fin debe ser posterior");
    });
  });

  describe("errores del proveedor", () => {
    it("propaga error 403 cuando no hay permisos para escribir en el calendario", async () => {
      const client = makeClient();
      (client.events.insert as jest.Mock).mockRejectedValue(
        Object.assign(new Error("Forbidden"), { code: 403 })
      );

      await expect(
        crearReserva(client, CALENDAR_ID, "Reunión", "2026-03-31", "10:00", "11:00", TIMEZONE)
      ).rejects.toThrow("Forbidden");
    });

    it("propaga timeout de red", async () => {
      const client = makeClient();
      (client.events.insert as jest.Mock).mockRejectedValue(new Error("ETIMEDOUT"));

      await expect(
        crearReserva(client, CALENDAR_ID, "Reunión", "2026-03-31", "10:00", "11:00", TIMEZONE)
      ).rejects.toThrow("ETIMEDOUT");
    });
  });
});

// ══════════════════════════════════════════
// cancelarReserva
// ══════════════════════════════════════════

describe("cancelarReserva", () => {
  describe("caso exitoso", () => {
    it("devuelve confirmación cuando Google elimina el evento", async () => {
      const client = makeClient();
      (client.events.delete as jest.Mock).mockResolvedValue({});

      const result = await cancelarReserva(client, CALENDAR_ID, "event-123");

      expect(result).toContain("cancelada correctamente");
    });

    it("llama a events.delete con el calendarId y eventId correctos", async () => {
      const client = makeClient();
      (client.events.delete as jest.Mock).mockResolvedValue({});

      await cancelarReserva(client, CALENDAR_ID, "event-123");

      expect(client.events.delete).toHaveBeenCalledWith({
        calendarId: CALENDAR_ID,
        eventId:    "event-123",
      });
    });

    it("maneja respuesta vacía de Google (204 No Content) correctamente", async () => {
      const client = makeClient();
      // Google devuelve body vacío en delete exitoso
      (client.events.delete as jest.Mock).mockResolvedValue(null);

      const result = await cancelarReserva(client, CALENDAR_ID, "event-123");

      expect(result).toContain("cancelada correctamente");
    });
  });

  describe("validaciones", () => {
    it("lanza error si el eventId está vacío", async () => {
      const client = makeClient();

      await expect(
        cancelarReserva(client, CALENDAR_ID, "")
      ).rejects.toThrow("El ID del evento no puede estar vacío");

      expect(client.events.delete).not.toHaveBeenCalled();
    });

    it("lanza error si el eventId es solo espacios", async () => {
      const client = makeClient();

      await expect(
        cancelarReserva(client, CALENDAR_ID, "   ")
      ).rejects.toThrow("El ID del evento no puede estar vacío");
    });
  });

  describe("errores del proveedor", () => {
    it("propaga error 404 cuando el evento no existe", async () => {
      const client = makeClient();
      (client.events.delete as jest.Mock).mockRejectedValue(
        Object.assign(new Error("Resource has been deleted"), { code: 404 })
      );

      await expect(
        cancelarReserva(client, CALENDAR_ID, "event-inexistente")
      ).rejects.toThrow("Resource has been deleted");
    });

    it("propaga error 403 sin permisos", async () => {
      const client = makeClient();
      (client.events.delete as jest.Mock).mockRejectedValue(
        Object.assign(new Error("Forbidden"), { code: 403 })
      );

      await expect(
        cancelarReserva(client, CALENDAR_ID, "event-123")
      ).rejects.toThrow("Forbidden");
    });

    it("propaga error 500 de Google", async () => {
      const client = makeClient();
      (client.events.delete as jest.Mock).mockRejectedValue(new Error("Internal Server Error"));

      await expect(
        cancelarReserva(client, CALENDAR_ID, "event-123")
      ).rejects.toThrow("Internal Server Error");
    });
  });
});

// ══════════════════════════════════════════
// listarProximasReservas
// ══════════════════════════════════════════

describe("listarProximasReservas", () => {
  describe("caso exitoso", () => {
    it("devuelve mensaje cuando no hay eventos próximos", async () => {
      const client = makeClient();
      (client.events.list as jest.Mock).mockResolvedValue({ data: { items: [] } });

      const result = await listarProximasReservas(client, CALENDAR_ID);

      expect(result).toContain("No tenés próximas reservas");
    });

    it("lista eventos con fecha, título e ID", async () => {
      const client = makeClient();
      (client.events.list as jest.Mock).mockResolvedValue({
        data: { items: [makeGoogleEvent()] }
      });

      const result = await listarProximasReservas(client, CALENDAR_ID);

      expect(result).toContain("Reunión con Juan");
      expect(result).toContain("event-123");
    });

    it("respeta la cantidad máxima pedida", async () => {
      const client = makeClient();
      (client.events.list as jest.Mock).mockResolvedValue({ data: { items: [] } });

      await listarProximasReservas(client, CALENDAR_ID, 10);

      expect(client.events.list).toHaveBeenCalledWith(
        expect.objectContaining({ maxResults: 10 })
      );
    });

    it("usa 5 como cantidad por defecto", async () => {
      const client = makeClient();
      (client.events.list as jest.Mock).mockResolvedValue({ data: { items: [] } });

      await listarProximasReservas(client, CALENDAR_ID);

      expect(client.events.list).toHaveBeenCalledWith(
        expect.objectContaining({ maxResults: 5 })
      );
    });

    it("muestra 'todo el día' para eventos allDay", async () => {
      const client = makeClient();
      (client.events.list as jest.Mock).mockResolvedValue({
        data: { items: [makeGoogleEvent({ start: { date: "2026-03-31" } })] }
      });

      const result = await listarProximasReservas(client, CALENDAR_ID);

      expect(result).toContain("todo el día");
    });

    it("maneja respuesta sin campo items sin explotar", async () => {
      const client = makeClient();
      (client.events.list as jest.Mock).mockResolvedValue({ data: {} });

      const result = await listarProximasReservas(client, CALENDAR_ID);

      expect(result).toContain("No tenés próximas reservas");
    });
  });

  describe("errores del proveedor", () => {
    it("propaga error 401 de Google", async () => {
      const client = makeClient();
      (client.events.list as jest.Mock).mockRejectedValue(new Error("Unauthorized"));

      await expect(
        listarProximasReservas(client, CALENDAR_ID)
      ).rejects.toThrow("Unauthorized");
    });
  });
});
