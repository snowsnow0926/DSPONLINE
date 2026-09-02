import { memo } from "react";

import type { FactoryConstructionHeadlineReadModel } from "../game/factoryReadModels";

/** Visible blueprint construction summary backed only by a bounded read model. */
export const BlueprintFactoryHeadline = memo(function BlueprintFactoryHeadline({ model }: {
  model: FactoryConstructionHeadlineReadModel;
}) {
  return <>
    <span
      data-factory-read-model-source={model.source}
      data-factory-read-model-revision={model.revision ?? "web"}
    >施工队列 <strong>{model.constructionQueueCount}</strong></span>
    <span>部署行星 <strong>{model.activePlanetDisplayName}</strong></span>
  </>;
});
