export interface NotifyEvent {
  pair: string;
  state: string;
  level: 'info' | 'warn';
  body: string;
  tsMs: number;
  tsUk: string;
}

export interface Notifier {
  ping(event: NotifyEvent): void;
}
