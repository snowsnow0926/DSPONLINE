/// <reference lib="webworker" />

import type { LocalSaveCatalog } from "./localSaveCatalog";
import { buildLocalSaveCatalog } from "./localSaveCatalogBuild";

interface LocalSaveCatalogWorkerRequest {
  id: number;
  key: string;
  payload: string;
  revision: number;
}

interface LocalSaveCatalogWorkerResponse {
  id: number;
  catalog?: LocalSaveCatalog;
  error?: string;
}

self.onmessage = (event: MessageEvent<LocalSaveCatalogWorkerRequest>) => {
  const request = event.data;
  try {
    const catalog = buildLocalSaveCatalog(request.key, request.payload, request.revision);
    self.postMessage({ id: request.id, catalog } satisfies LocalSaveCatalogWorkerResponse);
  } catch (error) {
    self.postMessage({
      id: request.id,
      error: error instanceof Error ? error.message : "本地存档目录索引失败",
    } satisfies LocalSaveCatalogWorkerResponse);
  }
};

export type { LocalSaveCatalogWorkerRequest, LocalSaveCatalogWorkerResponse };
