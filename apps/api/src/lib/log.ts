// Минимальный интерфейс логгера: подходит и Fastify/pino, и заглушкам в тестах
export type Logger = {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
};
