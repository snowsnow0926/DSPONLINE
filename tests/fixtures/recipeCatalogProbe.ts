import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { RecipeCatalogPicker } from "../../src/components/CatalogPicker";
import { RECIPES } from "../../src/game/content";
import "../../src/styles.css";
import "../../src/theme.css";
import "../../src/styles/native-app.css";
import "../../src/styles/ui-clarity.css";

export function mountRecipeCatalog(onChange: (id: string) => void) {
  createRoot(document.getElementById("root")!).render(createElement(RecipeCatalogPicker, {
    value: "gear", recipes: Object.values(RECIPES), onChange,
  }));
}
