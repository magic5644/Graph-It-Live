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
  private disposePromise: Promise<void> | null = null;

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
      registration.instance ??= registration.factory();
      return registration.instance;
    }

    return registration.factory();
  }

  dispose(): Promise<void> {
    this.disposePromise ??= this.disposeServices();
    return this.disposePromise;
  }

  private async disposeServices(): Promise<void> {
    const instances = [...this.services.values()]
      .map((registration) => registration.instance as
        | { dispose?: () => void | PromiseLike<void> }
        | undefined)
      .filter((instance): instance is { dispose?: () => void | PromiseLike<void> } =>
        instance !== undefined,
      );
    this.services.clear();

    await Promise.all(instances.map(async (instance) => {
      await instance.dispose?.();
    }));
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
