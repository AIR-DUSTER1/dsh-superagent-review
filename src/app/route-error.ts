/** Client-facing validation or lookup error raised inside an HTTP route. */
export class RouteError extends Error {
  constructor(readonly status: 400 | 403 | 404, message: string) { super(message) }
}
