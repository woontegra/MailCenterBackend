import { Server as HTTPServer } from 'http';
import { Server, Socket } from 'socket.io';
import jwt from 'jsonwebtoken';

let io: Server;

export const initializeSocket = (server: HTTPServer) => {
  io = new Server(server, {
    cors: {
      origin: process.env.FRONTEND_URL || '*',
      methods: ['GET', 'POST'],
    },
  });

  io.use((socket: Socket, next) => {
    const token = socket.handshake.auth.token;
    if (!token) {
      return next(new Error('Authentication error'));
    }

    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET || 'secret') as any;
      (socket as any).userId = decoded.userId;
      (socket as any).tenantId = decoded.tenantId;
      next();
    } catch (error) {
      next(new Error('Authentication error'));
    }
  });

  io.on('connection', (socket: Socket) => {
    const tenantId = (socket as any).tenantId;
    const userId = (socket as any).userId;

    socket.join(`tenant:${tenantId}`);
    socket.join(`user:${userId}`);

    console.log(`User ${userId} connected to tenant ${tenantId}`);

    socket.on('disconnect', () => {
      console.log(`User ${userId} disconnected`);
    });
  });

  return io;
};

export const getIO = () => {
  if (!io) {
    throw new Error('Socket.io not initialized');
  }
  return io;
};

export const emitToTenant = (tenantId: number, event: string, data: any) => {
  if (io) {
    io.to(`tenant:${tenantId}`).emit(event, data);
  }
};

export const emitToUser = (userId: number, event: string, data: any) => {
  if (io) {
    io.to(`user:${userId}`).emit(event, data);
  }
};
