import { EventEmitter } from "node:events";
import type { EventMap } from "./types.js";

type EventKey = keyof EventMap;
type Handler<K extends EventKey> = (payload: EventMap[K]) => void;

export class TypedEventBus {
  private readonly emitter = new EventEmitter();

  emit<K extends EventKey>(event: K, payload: EventMap[K]): boolean {
    return this.emitter.emit(event, payload);
  }

  on<K extends EventKey>(event: K, handler: Handler<K>): this {
    this.emitter.on(event, handler as (...args: unknown[]) => void);
    return this;
  }

  once<K extends EventKey>(event: K, handler: Handler<K>): this {
    this.emitter.once(event, handler as (...args: unknown[]) => void);
    return this;
  }

  off<K extends EventKey>(event: K, handler: Handler<K>): this {
    this.emitter.off(event, handler as (...args: unknown[]) => void);
    return this;
  }

  setMaxListeners(n: number): this {
    this.emitter.setMaxListeners(n);
    return this;
  }
}

/** Singleton bus instance for the pipeline */
export const bus = new TypedEventBus();
