// Ошибка с кодом, который безопасно отдавать клиенту.
export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
  ) {
    super(code);
  }
}
