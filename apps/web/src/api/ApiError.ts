export type ValidationIssue = { path: string; message: string };

// Ошибка ответа API: { error: { code, issues? } }
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly issues?: ValidationIssue[],
  ) {
    super(code);
    this.name = "ApiError";
  }
}
