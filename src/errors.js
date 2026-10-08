/** An expected error with an HTTP status; its message is safe to show to the user. */
export class ForumError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
