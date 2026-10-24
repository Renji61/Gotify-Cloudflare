// The part of the server that deals with open /stream WebSockets. The server
// logic (server.ts) only talks to this interface; worker.ts implements it with
// the Durable Object WebSocket Hibernation API, the tests with a fake.

export interface StreamHub {
  /**
   * Accepts an authenticated WebSocket upgrade for `userId`. `clientToken` is the
   * stored (public form) token of the client that connected, or "" when the
   * request used basic auth. Returns the response to send back (the 101
   * switching-protocols response in production).
   */
  accept(userId: number, clientToken: string): Response;

  /** Sends the JSON text of a new message to every open socket of the user. */
  broadcast(userId: number, json: string): void;

  /** Closes the sockets the user opened with this client token (client deleted or expired). */
  closeClient(userId: number, clientToken: string): void;

  /** Closes all sockets of a user (user deleted). */
  closeUser(userId: number): void;

  /** Distinct client tokens of all open sockets (empty tokens left out). */
  connectedTokens(): string[];

  /** Whether any socket is open. */
  hasConnections(): boolean;
}
