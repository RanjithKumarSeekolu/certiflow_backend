import { Server as HttpServer } from "http";
import { Server as SocketIOServer } from "socket.io";
import jwt from "jsonwebtoken";
import { corsOrigins, jwtSecret } from "../config/env";
import type { AuthenticatedUser } from "../middlewares/auth.middleware";

let io: SocketIOServer | null = null;

export function initSocketIO(httpServer: HttpServer): SocketIOServer {
  io = new SocketIOServer(httpServer, { cors: { origin: corsOrigins(), methods: ["GET", "POST"] } });

  // Only logged-in users may connect; rooms come from the verified token, never from the client.
  io.use((socket, next) => {
    try {
      const token = String(socket.handshake.auth?.token ?? "");
      socket.data.user = jwt.verify(token, jwtSecret()) as unknown as AuthenticatedUser;
      next();
    } catch {
      next(new Error("unauthorized"));
    }
  });

  io.on("connection", (socket) => {
    const user = socket.data.user as AuthenticatedUser;
    socket.join(`user:${user.id}`);
    socket.join(`role:${user.role}`);
    if (user.role === "DISTRICT_OFFICER" && user.districtId) socket.join(`district:${user.districtId}`);
  });

  return io;
}

export function getIO(): SocketIOServer | null {
  return io;
}

export function broadcastEvent(event: string, payload: unknown, room: string): void {
  io?.to(room).emit(event, payload);
}
