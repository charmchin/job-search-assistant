export class ActionError extends Error {
  constructor(
    message: string,
    public readonly status = 400,
    public readonly code = 'ACTION_REJECTED',
    public readonly details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}
