/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Application, Request, RequestHandler, Response } from 'express';
import type { ManagedRuntimeProvider } from '../managed-runtime-provider.js';
import { ManagedRuntimeProviderError } from '../managed-runtime-provider.js';
import {
  MANAGED_RUNTIME_PROTOCOL_VERSION,
  MANAGED_RUNTIME_ROUTE_PREFIX,
  ManagedRuntimeProtocolError,
  parseManagedRuntimeCancelRequest,
  parseManagedRuntimeExecuteRequest,
  parseManagedRuntimePrepareRequest,
} from '../managed-runtime-protocol.js';

export interface RegisterManagedRuntimeWorkerRoutesDeps {
  readonly provider: ManagedRuntimeProvider;
  readonly authorize: RequestHandler;
}

function requestSignal(
  req: Request,
  res: Response,
): {
  signal: AbortSignal;
  dispose(): void;
} {
  const controller = new AbortController();
  const abort = () => {
    if (!res.writableEnded && !controller.signal.aborted) {
      controller.abort(
        new DOMException(
          'Managed Runtime HTTP client disconnected.',
          'AbortError',
        ),
      );
    }
  };
  req.once('aborted', abort);
  res.once('close', abort);
  return {
    signal: controller.signal,
    dispose: () => {
      req.removeListener('aborted', abort);
      res.removeListener('close', abort);
    },
  };
}

function sendError(res: Response, error: unknown, fallbackStatus = 500): void {
  if (res.headersSent || res.writableEnded) return;
  if (error instanceof ManagedRuntimeProtocolError) {
    res.status(400).json({
      error: 'Managed Runtime request is invalid.',
      code: error.code,
    });
    return;
  }
  if (error instanceof ManagedRuntimeProviderError) {
    res.status(error.retryable ? 503 : 409).json({
      error: error.retryable
        ? 'Managed Runtime is unavailable.'
        : 'Managed Runtime request conflicts with its Session binding.',
      code: error.code,
    });
    return;
  }
  res.status(fallbackStatus).json({
    error: 'Managed Runtime operation failed.',
    code: 'managed_runtime_operation_failed',
  });
}

export function registerManagedRuntimeWorkerRoutes(
  app: Application,
  deps: RegisterManagedRuntimeWorkerRoutesDeps,
): void {
  app.post(
    `${MANAGED_RUNTIME_ROUTE_PREFIX}/prepare`,
    deps.authorize,
    async (req, res) => {
      try {
        const request = parseManagedRuntimePrepareRequest(req.body);
        await deps.provider.prepare(request).ready;
        res.status(200).json({
          protocolVersion: MANAGED_RUNTIME_PROTOCOL_VERSION,
          ready: true,
        });
      } catch (error) {
        sendError(res, error, 503);
      }
    },
  );

  app.post(
    `${MANAGED_RUNTIME_ROUTE_PREFIX}/manifest`,
    deps.authorize,
    async (req, res) => {
      const connection = requestSignal(req, res);
      try {
        const request = parseManagedRuntimePrepareRequest(req.body);
        const handle = deps.provider.prepare(request);
        const manifest = await handle.getManifest(connection.signal);
        res.status(200).json({
          protocolVersion: MANAGED_RUNTIME_PROTOCOL_VERSION,
          manifest,
        });
      } catch (error) {
        sendError(res, error);
      } finally {
        connection.dispose();
      }
    },
  );

  app.post(
    `${MANAGED_RUNTIME_ROUTE_PREFIX}/execute`,
    deps.authorize,
    async (req, res) => {
      const connection = requestSignal(req, res);
      try {
        const request = parseManagedRuntimeExecuteRequest(req.body);
        const handle = deps.provider.prepare(request);
        const result = await handle.execute(
          request.toolRequest,
          connection.signal,
        );
        res.status(200).json({
          protocolVersion: MANAGED_RUNTIME_PROTOCOL_VERSION,
          result,
        });
      } catch (error) {
        sendError(res, error);
      } finally {
        connection.dispose();
      }
    },
  );

  app.post(
    `${MANAGED_RUNTIME_ROUTE_PREFIX}/cancel`,
    deps.authorize,
    async (req, res) => {
      try {
        const request = parseManagedRuntimeCancelRequest(req.body);
        const cancelled = await deps.provider.cancel(
          request.sessionId,
          request.executionId,
          request,
        );
        res.status(200).json({
          protocolVersion: MANAGED_RUNTIME_PROTOCOL_VERSION,
          cancelled,
        });
      } catch (error) {
        sendError(res, error);
      }
    },
  );

  app.post(
    `${MANAGED_RUNTIME_ROUTE_PREFIX}/release`,
    deps.authorize,
    async (req, res) => {
      try {
        const request = parseManagedRuntimePrepareRequest(req.body);
        const released = await deps.provider.release(
          request.sessionId,
          request,
        );
        res.status(200).json({
          protocolVersion: MANAGED_RUNTIME_PROTOCOL_VERSION,
          released,
        });
      } catch (error) {
        sendError(res, error);
      }
    },
  );
}
