import type { PlanetId } from "../game/types";

export const PLANET_NAMES_EN: Readonly<Record<string, string>> = {
  home: "Clearwater I",
  ashen: "Cinderfield II",
  giant: "Azurewind III",
  frost: "Frostplain I",
  boreal_giant: "Deepblue II",
  magnetar: "Polar Night I",
  verdant: "Verdant Ring I",
  pelagic: "Pelagic Deep II",
  aurora_giant: "Skyvault III",
  dune: "Red Dune I",
  cinder: "Ashfall II",
  ember_giant: "Redstorm III",
  crystal: "Crystal Vault I",
  prairie: "Cloudpasture II",
  sirius_giant: "Silver Crown III",
  salt: "White Salt I",
  obsidian: "Obsidian II",
  white_giant: "Pale Giant III",
  tempest: "Tempest I",
  inferno: "Inferno Core II",
  abyss: "Abyss III",
  azure_giant: "Azure Vault IV",
};

export function getPlanetEnglishName(planetId: PlanetId): string {
  return PLANET_NAMES_EN[planetId] ?? planetId;
}
