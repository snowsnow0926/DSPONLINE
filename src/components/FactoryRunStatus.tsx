import { memo } from "react";

import type { FactoryRunStatusReadModel } from "../game/factoryReadModels";

/** Visible run-state chip backed only by a bounded read model. */
export const FactoryRunStatus = memo(function FactoryRunStatus({ model }: {
  model: FactoryRunStatusReadModel;
}) {
  return (
    <span
      className={model.paused ? "paused" : "running"}
      data-factory-read-model-source={model.source}
      data-factory-read-model-revision={model.revision ?? "web"}
    >
      {model.paused ? "模拟暂停" : "实时运行"}
    </span>
  );
});
