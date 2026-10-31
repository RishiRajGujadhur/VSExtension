export async function send(message: string): Promise<string> {
  return message.trim();
}

export function notify(message: string): Promise<string> {
  return send(message);
}

export async function broadcast(messages: string[]): Promise<void> {
  for (const message of messages) {
    notify(message);
  }
}
