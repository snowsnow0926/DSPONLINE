import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { ItemCatalogPicker, RecipeCatalogPicker } from "../../src/components/CatalogPicker";
import { ITEMS, RECIPES } from "../../src/game/content";
import "../../src/styles.css";
import "../../src/theme.css";
import "../../src/styles/native-app.css";
import "../../src/styles/ui-clarity.css";

export function mountRecipeCatalog(onChange: (id: string) => void, categorized = false) {
  createRoot(document.getElementById("root")!).render(createElement(RecipeCatalogPicker, {
    value: "gear",
    recipes: Object.values(RECIPES).map((recipe, index) => categorized
      ? { ...recipe, categoryId: index % 2 === 0 ? "industry" : "materials" }
      : recipe),
    onChange,
  }));
}

export function mountItemCatalog(onChange: (id: string | null) => void) {
  createRoot(document.getElementById("root")!).render(createElement(ItemCatalogPicker, {
    value: "iron_ore",
    items: Object.values(ITEMS).map((item, index) => ({
      ...item, categoryId: index % 2 === 0 ? "industry" : "materials",
    })),
    onChange,
  }));
}
