import type * as vscode from "vscode";

export type ServiceToken<T> = symbol & { __type?: T };
export type ServiceFactory<T> = () => T;
export type ServiceLifetime = "singleton" | "transient";

interface ServiceRegistration<T> {
  factory: ServiceFactory<T>;
  lifetime: ServiceLifetime;
  instance?: T;
}

export class ServiceContainer {
  private readonly services = new Map<symbol, ServiceRegistration<unknown>>();

  register<T>(
    token: ServiceToken<T>,
    factory: ServiceFactory<T>,
    lifetime: ServiceLifetime = "singleton",
  ): void {
    this.services.set(token, { factory, lifetime });
  }

  has<T>(token: ServiceToken<T>): boolean {
    return this.services.has(token);
  }

  get<T>(token: ServiceToken<T>): T {
    const registration = this.services.get(token) as
      | ServiceRegistration<T>
      | undefined;

    if (!registration) {
      throw new Error(`Service not registered: ${token.toString()}`);
    }

    if (registration.lifetime === "singleton") {
      if (!registration.instance) {
        registration.instance = registration.factory();
      }
      return registration.instance;
    }

    return registration.factory();
  }

  async dispose(): Promise<void> {
    const disposals: Promise<void>[] = [];

    for (const registration of this.services.values()) {
      const instance = registration.instance as
        | { dispose?: () => void | Promise<void> }
        | undefined;
      if (instance?.dispose) {
        const result = instance.dispose();
        if (result && typeof (result as Promise<void>).then === "function") {
          disposals.push(result as Promise<void>);
        }
      }
    }

    if (disposals.length > 0) {
      await Promise.all(disposals);
    }

    this.services.clear();
  }
}

export function registerDisposable(
  context: vscode.ExtensionContext,
  disposable?: vscode.Disposable,
): void {
  if (disposable) {
    context.subscriptions.push(disposable);
  }
}
