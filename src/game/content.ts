import type {
  BeltTier,
  BuildingDefinition,
  BuildingId,
  ConstructionId,
  ConstructionDefinition,
  ConveyorBeltId,
  ItemDefinition,
  ItemId,
  PlanetDefinition,
  PlanetId,
  ProliferatorTier,
  RecipeDefinition,
  RecipeId,
  SorterId,
  SorterTier,
  StarSystemDefinition,
  StarSystemId,
  TechnologyDefinition,
  TechId,
} from "./types";

export const PLANETS: Record<PlanetId, PlanetDefinition> = {
  home: {
    id: "home",
    name: "澄海 I",
    code: "母星",
    color: "#61b2aa",
    environment: "海洋型行星",
    resources: "铁、铜、石、煤、原油、水",
    kind: "terrestrial",
    defaultTemplateId: "oceanic",
    systemId: "helios",
    orbitIndex: 1,
    solarMultiplier: 1,
  },
  ashen: {
    id: "ashen",
    name: "烬原 II",
    code: "熔岩星",
    color: "#d8794d",
    environment: "熔岩型行星",
    resources: "钛、硅、铁、铜、石、煤、硫酸、金伯利矿、分形硅、有机晶体",
    kind: "terrestrial",
    defaultTemplateId: "lava",
    systemId: "helios",
    orbitIndex: 2,
    solarMultiplier: 1.5,
  },
  giant: {
    id: "giant",
    name: "苍岚 III",
    code: "气态巨星",
    color: "#75a9bd",
    environment: "冰气态巨星",
    resources: "氢、氘、可燃冰",
    kind: "gas-giant",
    defaultTemplateId: "ice_giant",
    systemId: "helios",
    orbitIndex: 3,
    solarMultiplier: 0,
    orbitalYields: { hydrogen: 1, deuterium: 0.2, fire_ice: 0.5 },
  },
  frost: {
    id: "frost",
    name: "霜原 I",
    code: "冰原星",
    color: "#91b8c4",
    environment: "永冻冰原行星",
    resources: "铁、铜、钛、硅、可燃冰、光栅石、刺笋结晶",
    kind: "terrestrial",
    defaultTemplateId: "ice_field",
    systemId: "borealis",
    orbitIndex: 1,
    solarMultiplier: 0.8,
  },
  boreal_giant: {
    id: "boreal_giant",
    name: "青冥 II",
    code: "冰巨星",
    color: "#6b94ad",
    environment: "富可燃冰气态巨星",
    resources: "氢、氘、高丰度可燃冰",
    kind: "gas-giant",
    defaultTemplateId: "fire_ice_giant",
    systemId: "borealis",
    orbitIndex: 2,
    solarMultiplier: 0,
    orbitalYields: { hydrogen: 0.8, deuterium: 0.12, fire_ice: 1 },
  },
  magnetar: {
    id: "magnetar",
    name: "极夜 I",
    code: "磁暴星",
    color: "#a48ac2",
    environment: "中子星潮汐锁定行星",
    resources: "铁、铜、钛、硅、单极磁石",
    kind: "terrestrial",
    defaultTemplateId: "tidal_locked",
    systemId: "neutron",
    orbitIndex: 1,
    solarMultiplier: 0.45,
  },
  verdant: {
    id: "verdant", name: "翠环 I", code: "绿洲星", color: "#72aa78", environment: "草原与浅海行星",
    resources: "由星区种子生成", kind: "terrestrial", defaultTemplateId: "prairie", systemId: "aurora", orbitIndex: 1, solarMultiplier: 1.2,
  },
  pelagic: {
    id: "pelagic", name: "澜渊 II", code: "深海星", color: "#4d9fb4", environment: "深海群岛行星",
    resources: "由星区种子生成", kind: "terrestrial", defaultTemplateId: "mediterranean", systemId: "aurora", orbitIndex: 2, solarMultiplier: 1.05,
  },
  aurora_giant: {
    id: "aurora_giant", name: "天穹 III", code: "氢巨星", color: "#8fa9cf", environment: "高氢气态巨星",
    resources: "氢、氘", kind: "gas-giant", defaultTemplateId: "hydrogen_giant", systemId: "aurora", orbitIndex: 3, solarMultiplier: 0,
    orbitalYields: { hydrogen: 1.35, deuterium: 0.28 },
  },
  dune: {
    id: "dune", name: "赤砂 I", code: "荒漠星", color: "#c7965d", environment: "干旱沙漠行星",
    resources: "由星区种子生成", kind: "terrestrial", defaultTemplateId: "desert", systemId: "ember", orbitIndex: 1, solarMultiplier: 1.35,
  },
  cinder: {
    id: "cinder", name: "灰烬 II", code: "火山灰星", color: "#a9634f", environment: "火山灰与熔岩行星",
    resources: "由星区种子生成", kind: "terrestrial", defaultTemplateId: "volcanic_ash", systemId: "ember", orbitIndex: 2, solarMultiplier: 1.1,
  },
  ember_giant: {
    id: "ember_giant", name: "红飓 III", code: "气态巨星", color: "#b87964", environment: "高温气态巨星",
    resources: "氢、氘", kind: "gas-giant", defaultTemplateId: "gas_giant", systemId: "ember", orbitIndex: 3, solarMultiplier: 0,
    orbitalYields: { hydrogen: 1.1, deuterium: 0.18 },
  },
  crystal: {
    id: "crystal", name: "晶穹 I", code: "晶漠星", color: "#9ac4c6", environment: "硅晶荒漠行星",
    resources: "由星区种子生成", kind: "terrestrial", defaultTemplateId: "crystal_desert", systemId: "sirius", orbitIndex: 1, solarMultiplier: 1.55,
  },
  prairie: {
    id: "prairie", name: "牧云 II", code: "草原星", color: "#89aa67", environment: "风暴草原行星",
    resources: "由星区种子生成", kind: "terrestrial", defaultTemplateId: "savanna", systemId: "sirius", orbitIndex: 2, solarMultiplier: 1.2,
  },
  sirius_giant: {
    id: "sirius_giant", name: "银冠 III", code: "冰巨星", color: "#7ba8c5", environment: "明亮冰巨星",
    resources: "氢、氘、可燃冰", kind: "gas-giant", defaultTemplateId: "ice_giant", systemId: "sirius", orbitIndex: 3, solarMultiplier: 0,
    orbitalYields: { hydrogen: 0.9, deuterium: 0.2, fire_ice: 0.7 },
  },
  salt: {
    id: "salt", name: "白盐 I", code: "盐湖星", color: "#c5bf9a", environment: "盐湖与干海盆行星",
    resources: "由星区种子生成", kind: "terrestrial", defaultTemplateId: "salt_lake", systemId: "white_dwarf", orbitIndex: 1, solarMultiplier: 0.9,
  },
  obsidian: {
    id: "obsidian", name: "黑曜 II", code: "黑曜星", color: "#746b75", environment: "黑曜火山行星",
    resources: "由星区种子生成", kind: "terrestrial", defaultTemplateId: "volcanic_ash", systemId: "white_dwarf", orbitIndex: 2, solarMultiplier: 0.65,
  },
  white_giant: {
    id: "white_giant", name: "苍白 III", code: "冰巨星", color: "#a7bfd0", environment: "低温冰巨星",
    resources: "氢、氘、可燃冰", kind: "gas-giant", defaultTemplateId: "fire_ice_giant", systemId: "white_dwarf", orbitIndex: 3, solarMultiplier: 0,
    orbitalYields: { hydrogen: 0.75, deuterium: 0.14, fire_ice: 1.15 },
  },
  tempest: {
    id: "tempest", name: "风暴 I", code: "飓风星", color: "#5f9d91", environment: "高风速海陆行星",
    resources: "由星区种子生成", kind: "terrestrial", defaultTemplateId: "savanna", systemId: "blue_giant", orbitIndex: 1, solarMultiplier: 1.7,
  },
  inferno: {
    id: "inferno", name: "炽核 II", code: "熔岩星", color: "#d65f43", environment: "超高热熔岩行星",
    resources: "由星区种子生成", kind: "terrestrial", defaultTemplateId: "lava", systemId: "blue_giant", orbitIndex: 2, solarMultiplier: 1.45,
  },
  abyss: {
    id: "abyss", name: "幽冥 III", code: "永夜星", color: "#66778f", environment: "潮汐锁定永夜行星",
    resources: "由星区种子生成", kind: "terrestrial", defaultTemplateId: "tidal_locked", systemId: "blue_giant", orbitIndex: 3, solarMultiplier: 0.75,
  },
  azure_giant: {
    id: "azure_giant", name: "蓝穹 IV", code: "蓝巨星行星", color: "#5e83bd", environment: "高能气态巨星",
    resources: "氢、氘、可燃冰", kind: "gas-giant", defaultTemplateId: "hydrogen_giant", systemId: "blue_giant", orbitIndex: 4, solarMultiplier: 0,
    orbitalYields: { hydrogen: 1.5, deuterium: 0.35, fire_ice: 0.25 },
  },
};

export const PLANET_LIST = Object.values(PLANETS);

export const STAR_SYSTEMS: Record<StarSystemId, StarSystemDefinition> = {
  helios: {
    id: "helios",
    name: "赫利俄斯",
    code: "母恒星系",
    starType: "G 型主序星",
    defaultStarClassId: "g_main",
    color: "#e1b452",
    distanceLy: 0,
    description: "工业网络的起点，拥有海洋、熔岩与气态巨星三种基础生态。",
    planetIds: ["home", "ashen", "giant"],
    explorationCost: [],
  },
  borealis: {
    id: "borealis",
    name: "北冕座",
    code: "冰晶恒星系",
    starType: "K 型橙矮星",
    defaultStarClassId: "k_dwarf",
    color: "#79aeb9",
    distanceLy: 4.2,
    description: "低温行星保存了天然微观结构，是可燃冰与高阶晶体的主要产区。",
    planetIds: ["frost", "boreal_giant"],
    explorationCost: [
      { itemId: "space_warper", amount: 2 },
      { itemId: "information_matrix", amount: 10 },
    ],
    requiredTechId: "stellar_exploration",
  },
  aurora: {
    id: "aurora", name: "曙光庭", code: "F 型星系", starType: "F 型主序星", defaultStarClassId: "f_main", color: "#e8d99b", distanceLy: 9.4,
    description: "高光照星区，海洋与草原生态适合建立太阳能和综合制造基地。", planetIds: ["verdant", "pelagic", "aurora_giant"],
    explorationCost: [{ itemId: "space_warper", amount: 3 }, { itemId: "information_matrix", amount: 20 }], requiredTechId: "stellar_exploration", prerequisiteSystemId: "borealis",
  },
  ember: {
    id: "ember", name: "余烬座", code: "红矮星系", starType: "M 型红矮星", defaultStarClassId: "m_dwarf", color: "#c76c56", distanceLy: 15.7,
    description: "低亮度红矮星周围聚集着矿物丰厚的荒漠与火山世界。", planetIds: ["dune", "cinder", "ember_giant"],
    explorationCost: [{ itemId: "space_warper", amount: 4 }, { itemId: "gravity_matrix", amount: 10 }], requiredTechId: "stellar_exploration", prerequisiteSystemId: "aurora",
  },
  sirius: {
    id: "sirius", name: "天狼工域", code: "A 型星系", starType: "A 型主序星", defaultStarClassId: "a_main", color: "#dbe8ff", distanceLy: 20.4,
    description: "强光恒星与富硅晶体行星组成的高能工业区，戴森工程收益显著。", planetIds: ["crystal", "prairie", "sirius_giant"],
    explorationCost: [{ itemId: "space_warper", amount: 6 }, { itemId: "gravity_matrix", amount: 20 }], requiredTechId: "stellar_exploration", prerequisiteSystemId: "ember",
  },
  white_dwarf: {
    id: "white_dwarf", name: "苍白余烬", code: "白矮星系", starType: "白矮星", defaultStarClassId: "white_dwarf", color: "#d9e4ef", distanceLy: 18.7,
    description: "致密恒星周围保留盐湖、黑曜火山和冰巨星，适合作为星际中转节点。", planetIds: ["salt", "obsidian", "white_giant"],
    explorationCost: [{ itemId: "space_warper", amount: 8 }, { itemId: "universe_matrix", amount: 5 }], requiredTechId: "stellar_exploration", prerequisiteSystemId: "sirius",
  },
  neutron: {
    id: "neutron",
    name: "赫卡忒",
    code: "中子星系",
    starType: "中子星",
    defaultStarClassId: "neutron_star",
    color: "#a88ec5",
    distanceLy: 11.8,
    description: "极端磁场重塑了行星矿层，可持续开采极为稀有的单极磁石。",
    planetIds: ["magnetar"],
    explorationCost: [
      { itemId: "space_warper", amount: 5 },
      { itemId: "gravity_matrix", amount: 20 },
    ],
    requiredTechId: "stellar_exploration",
    prerequisiteSystemId: "borealis",
  },
  blue_giant: {
    id: "blue_giant", name: "蔚蓝王座", code: "蓝巨星系", starType: "O 型蓝巨星", defaultStarClassId: "o_blue_giant", color: "#6fa8ff", distanceLy: 30,
    description: "遥远而极亮的终局星区，戴森结构回报极高，但殖民与长航线成本同样惊人。", planetIds: ["tempest", "inferno", "abyss", "azure_giant"],
    explorationCost: [{ itemId: "space_warper", amount: 12 }, { itemId: "universe_matrix", amount: 20 }], requiredTechId: "stellar_exploration", prerequisiteSystemId: "white_dwarf",
  },
};

export const STAR_SYSTEM_LIST = Object.values(STAR_SYSTEMS);

export const ITEMS: Record<ItemId, ItemDefinition> = {
  iron_ore: { id: "iron_ore", name: "铁矿石", symbol: "Fe", color: "#9aa6a8", kind: "solid", description: "铁系生产链的基础矿物。" },
  copper_ore: { id: "copper_ore", name: "铜矿石", symbol: "Cu", color: "#d2764c", kind: "solid", description: "电气元件所需的基础矿物。" },
  coal: { id: "coal", name: "煤矿", symbol: "C", color: "#6e7471", kind: "solid", description: "燃料和高能石墨的基础资源。" },
  stone: { id: "stone", name: "石矿", symbol: "St", color: "#b5a68d", kind: "solid", description: "建筑材料与玻璃的基础原料。" },
  crude_oil: { id: "crude_oil", name: "原油", symbol: "Oil", color: "#735d46", kind: "fluid", description: "从原油涌泉持续萃取的化工原料。" },
  silicon_ore: { id: "silicon_ore", name: "硅石", symbol: "SiO", color: "#78948c", kind: "solid", description: "远端矿区出产的半导体基础矿物。" },
  titanium_ore: { id: "titanium_ore", name: "钛石", symbol: "TiO", color: "#80769c", kind: "solid", description: "远端矿区出产的高强度金属矿物。" },
  fire_ice: { id: "fire_ice", name: "可燃冰", symbol: "FI", color: "#87b9c5", kind: "solid", description: "气态巨星轨道中的稀有冰晶，可直接裂解为石墨烯和氢。" },
  kimberlite_ore: { id: "kimberlite_ore", name: "金伯利矿石", symbol: "Kim", color: "#8aa29c", kind: "solid", description: "富含天然金刚石结构的稀有矿物。" },
  fractal_silicon: { id: "fractal_silicon", name: "分形硅石", symbol: "FrSi", color: "#82aaa4", kind: "solid", description: "具有规则分形晶格的稀有硅矿，可高效加工晶格硅。" },
  optical_grating_crystal: { id: "optical_grating_crystal", name: "光栅石", symbol: "OGC", color: "#d4b866", kind: "solid", description: "天然形成的精密光栅晶体，可旁路高级光学和卡西米尔配方。" },
  spiniform_stalagmite_crystal: { id: "spiniform_stalagmite_crystal", name: "刺笋结晶", symbol: "SSC", color: "#829c9d", kind: "solid", description: "拥有天然纳米管结构的稀有晶体，可直接制造碳纳米管。" },
  unipolar_magnet: { id: "unipolar_magnet", name: "单极磁石", symbol: "UM", color: "#7c91b0", kind: "solid", description: "极端磁场环境形成的单极材料，可大幅简化粒子容器生产。" },
  water: { id: "water", name: "水", symbol: "H2O", color: "#529fc1", kind: "fluid", description: "由抽水站从海洋水源持续取得的化工原料。" },
  sulfuric_acid: { id: "sulfuric_acid", name: "硫酸", symbol: "H2S", color: "#b7b957", kind: "fluid", description: "可由化工厂合成，也可从熔岩星硫酸海洋直接抽取。" },
  iron_ingot: { id: "iron_ingot", name: "铁块", symbol: "I", color: "#c1cbcc", kind: "solid", description: "最常用的基础结构材料。" },
  copper_ingot: { id: "copper_ingot", name: "铜块", symbol: "C", color: "#e18b5d", kind: "solid", description: "导电元件的基础材料。" },
  magnet: { id: "magnet", name: "磁铁", symbol: "M", color: "#718da4", kind: "solid", description: "磁场设备的基础零件。" },
  stone_brick: { id: "stone_brick", name: "石材", symbol: "Br", color: "#c5bba9", kind: "solid", description: "耐热建筑结构材料。" },
  glass: { id: "glass", name: "玻璃", symbol: "Gl", color: "#8fc7c6", kind: "solid", description: "科研和光学设备所需材料。" },
  steel: { id: "steel", name: "钢材", symbol: "Stl", color: "#7f9298", kind: "solid", description: "重型工业设备所需的高强度结构材料。" },
  gear: { id: "gear", name: "齿轮", symbol: "G", color: "#d2aa5b", kind: "solid", description: "机械传动结构的通用零件。" },
  magnetic_coil: { id: "magnetic_coil", name: "磁线圈", symbol: "Mc", color: "#dd6d5b", kind: "solid", description: "由磁铁与铜块绕制而成。" },
  circuit_board: { id: "circuit_board", name: "电路板", symbol: "Cb", color: "#78b776", kind: "solid", description: "自动化设备的基础控制元件。" },
  prism: { id: "prism", name: "棱镜", symbol: "Pr", color: "#8ecbc3", kind: "solid", description: "由玻璃加工成的光学元件。" },
  plasma_exciter: { id: "plasma_exciter", name: "电浆激发器", symbol: "Px", color: "#d78961", kind: "solid", description: "原油萃取和精炼设备的关键部件。" },
  energetic_graphite: { id: "energetic_graphite", name: "高能石墨", symbol: "EG", color: "#817b8f", kind: "solid", description: "能源矩阵所需的高密度碳材料。" },
  refined_oil: { id: "refined_oil", name: "精炼油", symbol: "RO", color: "#c99a4b", kind: "fluid", description: "原油精炼的主要液体产物。" },
  hydrogen: { id: "hydrogen", name: "氢", symbol: "H", color: "#9dd5d3", kind: "fluid", description: "能源矩阵和后续化工链的重要气体资源。" },
  high_purity_silicon: { id: "high_purity_silicon", name: "高纯硅块", symbol: "Si", color: "#73aaa1", kind: "solid", description: "处理器与精密电子元件的基础半导体材料。" },
  titanium_ingot: { id: "titanium_ingot", name: "钛块", symbol: "Ti", color: "#978db4", kind: "solid", description: "结构矩阵产业链所需的高强度金属材料。" },
  titanium_alloy: { id: "titanium_alloy", name: "钛合金", symbol: "TiA", color: "#9d9cb9", kind: "solid", description: "钛、钢材与硫酸共同形成的耐高温星际结构材料。" },
  microcrystalline_component: { id: "microcrystalline_component", name: "微晶元件", symbol: "McC", color: "#67a994", kind: "solid", description: "以高纯硅块制造的精密半导体元件。" },
  processor: { id: "processor", name: "处理器", symbol: "CPU", color: "#60a985", kind: "solid", description: "星际物流与高级自动化设备的核心控制单元。" },
  logistics_drone: { id: "logistics_drone", name: "物流运输机", symbol: "LD", color: "#70aeb0", kind: "solid", description: "装载到行星物流站后执行同一行星内的无线运输，每架运载 25 件货物。" },
  logistics_vessel: { id: "logistics_vessel", name: "物流运输船", symbol: "LV", color: "#d4865d", kind: "solid", description: "装载到星际物流站后执行跨行星运输，每艘运载 100 件货物。" },
  space_warper: { id: "space_warper", name: "空间翘曲器", symbol: "Wrp", color: "#8c79c7", kind: "solid", description: "供物流运输船跨恒星航行时消耗的曲率驱动介质。" },
  accumulator: { id: "accumulator", name: "蓄电器", symbol: "Acc", color: "#789993", kind: "solid", description: "可由能量枢纽充电并跨行星运输的空储能单元。" },
  charged_accumulator: { id: "charged_accumulator", name: "蓄电器（满）", symbol: "Acc+", color: "#8fc8a3", kind: "solid", description: "储有 90 MJ 电能，可在能量枢纽放电后还原为空蓄电器。" },
  graphene: { id: "graphene", name: "石墨烯", symbol: "Gr", color: "#749692", kind: "solid", description: "由高能石墨剥离形成的二维碳材料。" },
  carbon_nanotube: { id: "carbon_nanotube", name: "碳纳米管", symbol: "CNT", color: "#7e969d", kind: "solid", description: "石墨烯与钛材料形成的高强度纳米结构。" },
  proliferator_mk1: { id: "proliferator_mk1", name: "增产剂 Mk.I", symbol: "P1", color: "#8f9872", kind: "solid", description: "由煤加工的基础喷涂介质，每件提供 12 个喷涂点数。" },
  proliferator_mk2: { id: "proliferator_mk2", name: "增产剂 Mk.II", symbol: "P2", color: "#56a58f", kind: "solid", description: "加入金刚石强化的增产剂，每件提供 24 个喷涂点数。" },
  proliferator_mk3: { id: "proliferator_mk3", name: "增产剂 Mk.III", symbol: "P3", color: "#628fba", kind: "solid", description: "利用碳纳米管稳定喷涂结构，每件提供 60 个喷涂点数。" },
  crystal_silicon: { id: "crystal_silicon", name: "晶格硅", symbol: "CSi", color: "#84b5a5", kind: "solid", description: "由高纯硅块进一步重排得到的精密晶格材料。" },
  particle_broadband: { id: "particle_broadband", name: "粒子宽带", symbol: "PB", color: "#b486b1", kind: "solid", description: "由纳米碳、晶格硅与塑料制造的信息载体。" },
  electric_motor: { id: "electric_motor", name: "电动机", symbol: "Mot", color: "#547e91", kind: "solid", description: "由铁、齿轮与磁线圈制造的基础动力组件。" },
  electromagnetic_turbine: { id: "electromagnetic_turbine", name: "电磁涡轮", symbol: "Tur", color: "#4f9b9e", kind: "solid", description: "高速电磁设备与粒子容器所需的动力核心。" },
  super_magnetic_ring: { id: "super_magnetic_ring", name: "超级磁场环", symbol: "SMR", color: "#3fa6a0", kind: "solid", description: "约束高能粒子和制造氘核燃料棒的强磁组件。" },
  particle_container: { id: "particle_container", name: "粒子容器", symbol: "PC", color: "#71a9aa", kind: "solid", description: "利用电磁涡轮与石墨烯约束高能粒子的容器。" },
  deuterium: { id: "deuterium", name: "氘", symbol: "D", color: "#86c7d0", kind: "fluid", description: "由氢在粒子对撞过程中富集得到的高能同位素。" },
  hydrogen_fuel_rod: { id: "hydrogen_fuel_rod", name: "氢燃料棒", symbol: "HFR", color: "#7ab4c0", kind: "solid", description: "将氢封装为便于运输和火力发电的中密度燃料。" },
  deuteron_fuel_rod: { id: "deuteron_fuel_rod", name: "氘核燃料棒", symbol: "DFR", color: "#67b8c0", kind: "solid", description: "以氘和超级磁场环封装的高密度燃料。" },
  titanium_glass: { id: "titanium_glass", name: "钛化玻璃", symbol: "TiG", color: "#8fc6c1", kind: "solid", description: "兼具高透明度与结构强度的精密材料。" },
  casimir_crystal: { id: "casimir_crystal", name: "卡西米尔晶体", symbol: "Cas", color: "#74b9a4", kind: "solid", description: "利用氢与纳米材料形成的量子级晶体。" },
  plane_filter: { id: "plane_filter", name: "位面过滤器", symbol: "PF", color: "#75a2bd", kind: "solid", description: "由卡西米尔晶体与钛化玻璃组成的精密过滤结构。" },
  quantum_chip: { id: "quantum_chip", name: "量子芯片", symbol: "QC", color: "#6d8ec0", kind: "solid", description: "引力矩阵所需的高性能量子运算核心。" },
  strange_matter: { id: "strange_matter", name: "奇异物质", symbol: "SM", color: "#ae86bf", kind: "solid", description: "由粒子对撞机在极端能级下制造的非常规物质。" },
  graviton_lens: { id: "graviton_lens", name: "引力透镜", symbol: "GL", color: "#8fb676", kind: "solid", description: "利用奇异物质改变局部引力场的精密器件。" },
  photon_combiner: { id: "photon_combiner", name: "光子合并器", symbol: "PhC", color: "#d8b65f", kind: "solid", description: "汇聚光能并稳定太阳帆工作面的光学部件。" },
  solar_sail: { id: "solar_sail", name: "太阳帆", symbol: "Sail", color: "#e4c55f", kind: "solid", description: "由电磁轨道弹射器发射到恒星轨道，为戴森云提供能量。" },
  critical_photon: { id: "critical_photon", name: "临界光子", symbol: "CP", color: "#d8e2d7", kind: "solid", description: "射线接收站在光子模式下凝聚的高能光子。" },
  antimatter: { id: "antimatter", name: "反物质", symbol: "AM", color: "#d3c4e5", kind: "fluid", description: "由临界光子进行质能转换得到的高能物质。" },
  annihilation_constraint_sphere: { id: "annihilation_constraint_sphere", name: "湮灭约束球", symbol: "ACS", color: "#93a5b8", kind: "solid", description: "约束反物质湮灭反应的精密容器。" },
  antimatter_fuel_rod: { id: "antimatter_fuel_rod", name: "反物质燃料棒", symbol: "AFR", color: "#c9bde1", kind: "solid", description: "封装反物质与氢的终极高密度燃料。" },
  frame_material: { id: "frame_material", name: "框架材料", symbol: "Frm", color: "#7faeb0", kind: "solid", description: "由碳纳米管、钛合金和高纯硅构成的戴森球高强度骨架材料。" },
  dyson_sphere_component: { id: "dyson_sphere_component", name: "戴森球组件", symbol: "DSC", color: "#81b79f", kind: "solid", description: "封装框架、太阳帆和处理器的戴森球结构组件。" },
  small_carrier_rocket: { id: "small_carrier_rocket", name: "小型运载火箭", symbol: "Rkt", color: "#d18a58", kind: "solid", description: "由垂直发射井送入恒星轨道，用于建设戴森球永久结构。" },
  diamond: { id: "diamond", name: "金刚石", symbol: "Dia", color: "#a8d5ce", kind: "solid", description: "由高能石墨重排形成的高强度晶体。" },
  plastic: { id: "plastic", name: "塑料", symbol: "Pl", color: "#d1c3a3", kind: "solid", description: "精炼油与高能石墨合成的高分子材料。" },
  organic_crystal: { id: "organic_crystal", name: "有机晶体", symbol: "Org", color: "#74ad69", kind: "solid", description: "由塑料、精炼油和水合成的有机材料。" },
  titanium_crystal: { id: "titanium_crystal", name: "钛晶石", symbol: "TiC", color: "#b19ac8", kind: "solid", description: "钛块与有机晶体形成的结构矩阵中间体。" },
  electromagnetic_matrix: { id: "electromagnetic_matrix", name: "电磁矩阵", symbol: "EM", color: "#56b8cf", kind: "matrix", description: "第一阶段科研矩阵。" },
  energy_matrix: { id: "energy_matrix", name: "能量矩阵", symbol: "En", color: "#d85f50", kind: "matrix", description: "由氢与高能石墨制成的第二阶段科研矩阵。" },
  structure_matrix: { id: "structure_matrix", name: "结构矩阵", symbol: "Str", color: "#dfba48", kind: "matrix", description: "由金刚石与钛晶石制成的第三阶段科研矩阵。" },
  information_matrix: { id: "information_matrix", name: "信息矩阵", symbol: "Inf", color: "#9b77cf", kind: "matrix", description: "由粒子宽带与处理器制成的第四阶段科研矩阵。" },
  gravity_matrix: { id: "gravity_matrix", name: "引力矩阵", symbol: "Grv", color: "#77bd76", kind: "matrix", description: "由引力透镜与量子芯片制成的第五阶段科研矩阵。" },
  universe_matrix: { id: "universe_matrix", name: "宇宙矩阵", symbol: "Uni", color: "#d9dedb", kind: "matrix", description: "五色矩阵与反物质融合形成的最终阶段科研矩阵。" },
};

export const MATRIX_ITEM_IDS: ItemId[] = [
  "electromagnetic_matrix",
  "energy_matrix",
  "structure_matrix",
  "information_matrix",
  "gravity_matrix",
  "universe_matrix",
];

export interface ProliferatorDefinition {
  tier: ProliferatorTier;
  itemId: ItemId;
  sprayPoints: number;
  extraProductBonus: number;
  speedBonus: number;
  powerMultiplier: number;
  requiredTechId: TechId;
}

export const PROLIFERATORS: Record<ProliferatorTier, ProliferatorDefinition> = {
  1: { tier: 1, itemId: "proliferator_mk1", sprayPoints: 12, extraProductBonus: 0.125, speedBonus: 0.25, powerMultiplier: 1.3, requiredTechId: "proliferator_1" },
  2: { tier: 2, itemId: "proliferator_mk2", sprayPoints: 24, extraProductBonus: 0.2, speedBonus: 0.5, powerMultiplier: 1.7, requiredTechId: "proliferator_2" },
  3: { tier: 3, itemId: "proliferator_mk3", sprayPoints: 60, extraProductBonus: 0.25, speedBonus: 1, powerMultiplier: 2.5, requiredTechId: "proliferator_3" },
};

export const PROLIFERATOR_ITEM_IDS = Object.values(PROLIFERATORS).map((definition) => definition.itemId);

export function getProliferator(tier: ProliferatorTier): ProliferatorDefinition {
  return PROLIFERATORS[tier];
}

export function getProliferatorTier(itemId: ItemId): ProliferatorTier | undefined {
  return (Object.values(PROLIFERATORS).find((definition) => definition.itemId === itemId)?.tier);
}

export const BUILDINGS: Record<BuildingId, BuildingDefinition> = {
  wind_turbine: {
    id: "wind_turbine", name: "风力涡轮机", shortName: "风机", kind: "power",
    powerGenerationKw: 300, speed: 1, inputCapacity: 0, outputCapacity: 0,
    description: "向当前星球电网提供 300 kW 电力。",
  },
  solar_panel: {
    id: "solar_panel", name: "太阳能板", shortName: "太阳能板", kind: "power",
    powerGenerationKw: 360, speed: 1, inputCapacity: 0, outputCapacity: 0,
    description: "将恒星辐射直接送入行星电网，烬原 II 的高日照环境可提升 50% 出力。",
  },
  geothermal_power_station: {
    id: "geothermal_power_station", name: "地热发电站", shortName: "地热站", kind: "power",
    powerGenerationKw: 4800, speed: 1, inputCapacity: 0, outputCapacity: 0,
    description: "只能部署在烬原 II，利用熔岩地热持续提供 4.8 MW 稳定电力。",
  },
  thermal_power_plant: {
    id: "thermal_power_plant", name: "火力发电厂", shortName: "火电厂", kind: "power",
    powerGenerationKw: 2160, speed: 1, inputCapacity: 120, outputCapacity: 0,
    description: "按电网缺口燃烧燃料，额定输出 2.16 MW，热能转换效率为 80%。",
  },
  mini_fusion_power_plant: {
    id: "mini_fusion_power_plant", name: "微型聚变发电站", shortName: "聚变站", kind: "power",
    powerGenerationKw: 15000, speed: 1, inputCapacity: 120, outputCapacity: 0,
    description: "消耗氘核燃料棒按电网缺口提供最高 15 MW 聚变电力。",
  },
  artificial_star: {
    id: "artificial_star", name: "人造恒星", shortName: "人造恒星", kind: "power",
    powerGenerationKw: 72000, speed: 1, inputCapacity: 30, outputCapacity: 0,
    description: "以反物质燃料棒维持湮灭反应，按电网缺口提供最高 72 MW 电力。",
  },
  accumulator: {
    id: "accumulator", name: "蓄电器", shortName: "蓄电器", kind: "power",
    powerGenerationKw: 900, powerChargeKw: 900, energyCapacityMj: 90,
    speed: 1, inputCapacity: 0, outputCapacity: 0,
    description: "内置 90 MJ 储能，电网富余时自动充电，供电不足时自动放电。",
  },
  energy_exchanger: {
    id: "energy_exchanger", name: "能量枢纽", shortName: "能量枢纽", kind: "power",
    powerGenerationKw: 45000, powerChargeKw: 45000, energyCapacityMj: 90,
    speed: 1, inputCapacity: 120, outputCapacity: 120,
    description: "以 45 MW 功率在空蓄电器与满蓄电器之间转换，形成可运输的跨行星储能闭环。",
  },
  mining_machine: {
    id: "mining_machine", name: "采矿机", shortName: "采矿机", kind: "miner",
    powerDemandKw: 420, speed: 0.5, inputCapacity: 0, outputCapacity: 180,
    description: "安装在矿脉上，持续把矿物送入节点输出缓存。",
  },
  arc_smelter: {
    id: "arc_smelter", name: "电弧熔炉", shortName: "熔炉", kind: "machine",
    powerDemandKw: 360, speed: 1, inputCapacity: 120, outputCapacity: 120, tier: 1, family: "smelter",
    description: "处理矿石、磁铁和基础建材。",
  },
  plane_smelter: {
    id: "plane_smelter", name: "位面熔炉", shortName: "位面熔炉", kind: "machine",
    powerDemandKw: 1440, speed: 2, inputCapacity: 240, outputCapacity: 240, tier: 2, family: "smelter",
    description: "以双倍配方速度处理全部熔炼配方，适合高吞吐冶金产线。",
  },
  assembling_machine_mk1: {
    id: "assembling_machine_mk1", name: "制造台 Mk.I", shortName: "制造台", kind: "machine",
    powerDemandKw: 270, speed: 0.75, inputCapacity: 120, outputCapacity: 120, tier: 1, family: "assembler",
    description: "以 0.75 倍配方速度组装基础零件。",
  },
  assembling_machine_mk2: {
    id: "assembling_machine_mk2", name: "制造台 Mk.II", shortName: "制造台 Mk.II", kind: "machine",
    powerDemandKw: 540, speed: 1, inputCapacity: 180, outputCapacity: 180, tier: 2, family: "assembler",
    description: "以标准配方速度组装物品，在相同节点规模下提供更高吞吐。",
  },
  assembling_machine_mk3: {
    id: "assembling_machine_mk3", name: "制造台 Mk.III", shortName: "制造台 Mk.III", kind: "machine",
    powerDemandKw: 1080, speed: 1.5, inputCapacity: 240, outputCapacity: 240, tier: 3, family: "assembler",
    description: "以 1.5 倍配方速度进行量子级装配，是最高等级的通用制造设备。",
  },
  spray_coater: {
    id: "spray_coater", name: "喷涂机", shortName: "喷涂模块", kind: "machine",
    powerDemandKw: 90, speed: 1, inputCapacity: 600, outputCapacity: 0,
    description: "作为生产节点的内联模块消耗增产剂，为当前配方提供额外产出或生产加速。",
  },
  matrix_lab: {
    id: "matrix_lab", name: "矩阵研究站", shortName: "研究站", kind: "machine",
    powerDemandKw: 480, speed: 1, inputCapacity: 120, outputCapacity: 120,
    description: "生产并研究科学矩阵。",
  },
  oil_extractor: {
    id: "oil_extractor", name: "原油萃取站", shortName: "萃取站", kind: "miner",
    powerDemandKw: 840, speed: 1, inputCapacity: 0, outputCapacity: 300,
    description: "安装在原油涌泉上，持续萃取原油。",
  },
  oil_refinery: {
    id: "oil_refinery", name: "原油精炼厂", shortName: "精炼厂", kind: "machine",
    powerDemandKw: 960, speed: 1, inputCapacity: 240, outputCapacity: 240,
    description: "执行原油精炼和 X 射线裂解等多产物配方。",
  },
  water_pump: {
    id: "water_pump", name: "抽水站", shortName: "抽水站", kind: "miner",
    powerDemandKw: 300, speed: 1, inputCapacity: 0, outputCapacity: 300,
    description: "部署在水或硫酸海洋上，以每秒 1 单位的基础速度抽取流体。",
  },
  chemical_plant: {
    id: "chemical_plant", name: "化工厂", shortName: "化工厂", kind: "machine",
    powerDemandKw: 720, speed: 1, inputCapacity: 240, outputCapacity: 240, tier: 1, family: "chemical",
    description: "执行塑料、有机晶体等高分子化工配方。",
  },
  quantum_chemical_plant: {
    id: "quantum_chemical_plant", name: "量子化工厂", shortName: "量子化工厂", kind: "machine",
    powerDemandKw: 2160, speed: 2, inputCapacity: 480, outputCapacity: 480, tier: 2, family: "chemical",
    description: "以双倍配方速度执行全部化工配方，可由普通化工厂原地升级。",
  },
  fractionator: {
    id: "fractionator", name: "分馏塔", shortName: "分馏塔", kind: "machine",
    powerDemandKw: 720, speed: 1, inputCapacity: 240, outputCapacity: 240,
    description: "循环处理氢并稳定分离氘，输出剩余氢形成可闭环的分馏物流。",
  },
  miniature_particle_collider: {
    id: "miniature_particle_collider", name: "微型粒子对撞机", shortName: "对撞机", kind: "machine",
    powerDemandKw: 12000, speed: 1, inputCapacity: 600, outputCapacity: 600,
    description: "消耗大量电力进行氘富集与奇异物质制造。",
  },
  em_rail_ejector: {
    id: "em_rail_ejector", name: "电磁轨道弹射器", shortName: "轨道弹射器", kind: "machine",
    powerDemandKw: 1800, speed: 1, inputCapacity: 180, outputCapacity: 0,
    description: "消耗太阳帆并将其发射到恒星轨道，持续扩充戴森云。",
  },
  ray_receiver: {
    id: "ray_receiver", name: "射线接收站", shortName: "接收站", kind: "machine",
    speed: 1, inputCapacity: 0, outputCapacity: 120,
    description: "共享戴森云恒星能，可切换电力输出或临界光子生成模式。",
  },
  vertical_launching_silo: {
    id: "vertical_launching_silo", name: "垂直发射井", shortName: "发射井", kind: "machine",
    powerDemandKw: 18000, speed: 1, inputCapacity: 180, outputCapacity: 0,
    description: "消耗小型运载火箭，在恒星轨道持续建设戴森球永久结构。",
  },
  planetary_logistics_station: {
    id: "planetary_logistics_station", name: "行星物流站", shortName: "行星站", kind: "station",
    powerDemandKw: 600, speed: 1, inputCapacity: 600, outputCapacity: 600, accepts: "any",
    description: "在同一行星内与异向站点自动配对，由需求站调度物流运输机完成无线货运。",
  },
  interstellar_logistics_station: {
    id: "interstellar_logistics_station", name: "星际物流站", shortName: "星际站", kind: "station",
    powerDemandKw: 1200, speed: 1, inputCapacity: 1000, outputCapacity: 1000, accepts: "any",
    description: "与另一行星的异向站点自动配对，由需求站调度已装载的运输船执行跨行星货运。",
  },
  orbital_collector: {
    id: "orbital_collector", name: "轨道采集器", shortName: "轨道采集器", kind: "station",
    speed: 1, inputCapacity: 0, outputCapacity: 2000, accepts: "any",
    description: "只能部署在气态巨星，持续采集氢、氘或可燃冰，并作为星际物流系统的远程供应端。",
  },
  storage_mk1: {
    id: "storage_mk1", name: "小型储物仓", shortName: "储物仓", kind: "storage",
    speed: 1, inputCapacity: 600, outputCapacity: 600, accepts: "solid",
    description: "缓存一种固体物品，并向后续物流线路持续供货。",
  },
  material_delivery_hub: {
    id: "material_delivery_hub", name: "物资配送枢纽", shortName: "配送枢纽", kind: "storage",
    speed: 1, inputCapacity: 900, outputCapacity: 0, accepts: "any",
    description: "提供 3 个独立输入接口，送达的物品会立即进入所在行星的物资托盘。",
  },
  orbital_cargo_terminal: {
    id: "orbital_cargo_terminal", name: "轨道货运终端", shortName: "轨道终端", kind: "storage",
    powerDemandKw: 50_000, speed: 1, inputCapacity: 1_000_000, outputCapacity: 0, accepts: "any", megastructure: true,
    description: "全星系空间站的行星物资入口。四个稳定输入口共享每分钟 20,000 件上传能力，每颗已殖民行星最多一座。",
  },
  storage_tank: {
    id: "storage_tank", name: "储液罐", shortName: "储液罐", kind: "storage",
    speed: 1, inputCapacity: 1200, outputCapacity: 1200, accepts: "fluid",
    description: "缓存原油、精炼油、氢或氘等流体资源。",
  },
  splitter_4way: {
    id: "splitter_4way", name: "四向分流器", shortName: "分流器", kind: "splitter",
    speed: 1, inputCapacity: 24, outputCapacity: 24, accepts: "any",
    description: "在多条输出运输线之间均分物资，并支持优先线路。",
  },
  construction_center: {
    id: "construction_center", name: "建筑制造中心", shortName: "制造中心", kind: "machine",
    powerDemandKw: 12000, speed: 1, inputCapacity: 0, outputCapacity: 0, megastructure: true,
    description: "巨构级建筑补给设施，从所在行星物资托盘取料并按目标库存持续补足施工设备。",
  },
  galactic_material_exporter: {
    id: "galactic_material_exporter", name: "超大型物资出口", shortName: "银河出口", kind: "machine",
    powerDemandKw: 24000, speed: 1, inputCapacity: 1_000_000, outputCapacity: 0, accepts: "any", megastructure: true,
    description: "银河终局工程的实体交付设施，通过四个专用输入端口接收宇宙矩阵、太阳帆、小型运载火箭和反物质燃料棒。",
  },
  micro_black_hole_connector: {
    id: "micro_black_hole_connector", name: "微型黑洞连接装置", shortName: "黑洞连接器", kind: "machine",
    speed: 1, inputCapacity: 0, outputCapacity: 0, accepts: "any", megastructure: true,
    description: "通过三个独立通用输入口永久销毁传送带送达的物资，并以十进制精确记录累计销毁量。",
  },
  time_warp_device: {
    id: "time_warp_device", name: "时间扭曲装置", shortName: "时间扭曲", kind: "machine",
    speed: 1, inputCapacity: 0, outputCapacity: 0, megastructure: true,
    description: "消耗所在电网的剩余功率加速全存档实时模拟；离线收益和活动墙钟不受影响。",
  },
  space_station_construction_launcher: {
    id: "space_station_construction_launcher", name: "空间站施工发射平台", shortName: "空间站平台", kind: "station",
    powerDemandKw: 10000, speed: 1, inputCapacity: 4000, outputCapacity: 0, accepts: "any", megastructure: true,
    description: "将所在行星的终局材料真实送入本恒星系空间站工地。每颗行星最多建设一座。",
  },
};

export const RECIPES: Record<RecipeId, RecipeDefinition> = {
  iron_ingot: { id: "iron_ingot", name: "铁块", buildingId: "arc_smelter", duration: 1, inputs: [{ itemId: "iron_ore", amount: 1 }], outputs: [{ itemId: "iron_ingot", amount: 1 }] },
  copper_ingot: { id: "copper_ingot", name: "铜块", buildingId: "arc_smelter", duration: 1, inputs: [{ itemId: "copper_ore", amount: 1 }], outputs: [{ itemId: "copper_ingot", amount: 1 }] },
  magnet: { id: "magnet", name: "磁铁", buildingId: "arc_smelter", duration: 1.5, inputs: [{ itemId: "iron_ore", amount: 1 }], outputs: [{ itemId: "magnet", amount: 1 }] },
  stone_brick: { id: "stone_brick", name: "石材", buildingId: "arc_smelter", duration: 1, inputs: [{ itemId: "stone", amount: 1 }], outputs: [{ itemId: "stone_brick", amount: 1 }] },
  glass: { id: "glass", name: "玻璃", buildingId: "arc_smelter", duration: 2, inputs: [{ itemId: "stone", amount: 2 }], outputs: [{ itemId: "glass", amount: 1 }] },
  steel: { id: "steel", name: "钢材", buildingId: "arc_smelter", duration: 3, requiredTechId: "high_efficiency_plasma_control", inputs: [{ itemId: "iron_ingot", amount: 3 }], outputs: [{ itemId: "steel", amount: 1 }] },
  energetic_graphite: { id: "energetic_graphite", name: "高能石墨", buildingId: "arc_smelter", duration: 2, requiredTechId: "energy_matrix", inputs: [{ itemId: "coal", amount: 2 }], outputs: [{ itemId: "energetic_graphite", amount: 1 }] },
  gear: { id: "gear", name: "齿轮", buildingId: "assembling_machine_mk1", duration: 1, inputs: [{ itemId: "iron_ingot", amount: 1 }], outputs: [{ itemId: "gear", amount: 1 }] },
  magnetic_coil: { id: "magnetic_coil", name: "磁线圈", buildingId: "assembling_machine_mk1", duration: 1, inputs: [{ itemId: "magnet", amount: 2 }, { itemId: "copper_ingot", amount: 1 }], outputs: [{ itemId: "magnetic_coil", amount: 2 }] },
  circuit_board: { id: "circuit_board", name: "电路板", buildingId: "assembling_machine_mk1", duration: 1, inputs: [{ itemId: "iron_ingot", amount: 2 }, { itemId: "copper_ingot", amount: 1 }], outputs: [{ itemId: "circuit_board", amount: 2 }] },
  prism: { id: "prism", name: "棱镜", buildingId: "assembling_machine_mk1", duration: 2, requiredTechId: "high_efficiency_plasma_control", inputs: [{ itemId: "glass", amount: 3 }], outputs: [{ itemId: "prism", amount: 2 }] },
  plasma_exciter: { id: "plasma_exciter", name: "电浆激发器", buildingId: "assembling_machine_mk1", duration: 2, requiredTechId: "high_efficiency_plasma_control", inputs: [{ itemId: "magnetic_coil", amount: 4 }, { itemId: "prism", amount: 2 }], outputs: [{ itemId: "plasma_exciter", amount: 1 }] },
  plasma_refining: { id: "plasma_refining", name: "等离子精炼", buildingId: "oil_refinery", duration: 4, requiredTechId: "high_efficiency_plasma_control", inputs: [{ itemId: "crude_oil", amount: 2 }], outputs: [{ itemId: "refined_oil", amount: 2 }, { itemId: "hydrogen", amount: 1 }] },
  xray_cracking: { id: "xray_cracking", name: "X 射线裂解", buildingId: "oil_refinery", duration: 4, requiredTechId: "xray_cracking", inputs: [{ itemId: "refined_oil", amount: 2 }, { itemId: "hydrogen", amount: 1 }], outputs: [{ itemId: "energetic_graphite", amount: 1 }, { itemId: "hydrogen", amount: 3 }] },
  reforming_refine: { id: "reforming_refine", name: "重整精炼", buildingId: "oil_refinery", duration: 4, requiredTechId: "reforming_refine", inputs: [{ itemId: "coal", amount: 1 }, { itemId: "hydrogen", amount: 1 }, { itemId: "refined_oil", amount: 2 }], outputs: [{ itemId: "refined_oil", amount: 3 }] },
  high_purity_silicon: { id: "high_purity_silicon", name: "高纯硅块", buildingId: "arc_smelter", duration: 2, requiredTechId: "high_strength_crystal", inputs: [{ itemId: "silicon_ore", amount: 2 }], outputs: [{ itemId: "high_purity_silicon", amount: 1 }] },
  silicon_ore_from_stone: { id: "silicon_ore_from_stone", name: "石矿提炼硅石", buildingId: "arc_smelter", duration: 10, requiredTechId: "high_strength_crystal", inputs: [{ itemId: "stone", amount: 10 }], outputs: [{ itemId: "silicon_ore", amount: 1 }] },
  titanium_ingot: { id: "titanium_ingot", name: "钛块", buildingId: "arc_smelter", duration: 2, requiredTechId: "high_strength_crystal", inputs: [{ itemId: "titanium_ore", amount: 2 }], outputs: [{ itemId: "titanium_ingot", amount: 1 }] },
  sulfuric_acid: { id: "sulfuric_acid", name: "硫酸", buildingId: "chemical_plant", duration: 6, requiredTechId: "titanium_alloy", inputs: [{ itemId: "refined_oil", amount: 6 }, { itemId: "stone", amount: 8 }, { itemId: "water", amount: 4 }], outputs: [{ itemId: "sulfuric_acid", amount: 4 }] },
  titanium_alloy: { id: "titanium_alloy", name: "钛合金", buildingId: "arc_smelter", duration: 12, requiredTechId: "titanium_alloy", inputs: [{ itemId: "titanium_ingot", amount: 4 }, { itemId: "steel", amount: 4 }, { itemId: "sulfuric_acid", amount: 8 }], outputs: [{ itemId: "titanium_alloy", amount: 4 }] },
  microcrystalline_component: { id: "microcrystalline_component", name: "微晶元件", buildingId: "assembling_machine_mk1", duration: 2, requiredTechId: "processor", inputs: [{ itemId: "high_purity_silicon", amount: 2 }, { itemId: "copper_ingot", amount: 1 }], outputs: [{ itemId: "microcrystalline_component", amount: 1 }] },
  processor: { id: "processor", name: "处理器", buildingId: "assembling_machine_mk1", duration: 3, requiredTechId: "processor", inputs: [{ itemId: "circuit_board", amount: 2 }, { itemId: "microcrystalline_component", amount: 2 }], outputs: [{ itemId: "processor", amount: 1 }] },
  logistics_drone: { id: "logistics_drone", name: "物流运输机", buildingId: "assembling_machine_mk1", duration: 4, requiredTechId: "planetary_logistics", inputs: [{ itemId: "steel", amount: 5 }, { itemId: "processor", amount: 2 }, { itemId: "electromagnetic_turbine", amount: 2 }], outputs: [{ itemId: "logistics_drone", amount: 1 }] },
  logistics_vessel: { id: "logistics_vessel", name: "物流运输船", buildingId: "assembling_machine_mk1", duration: 8, requiredTechId: "interstellar_logistics", inputs: [{ itemId: "titanium_alloy", amount: 10 }, { itemId: "processor", amount: 10 }, { itemId: "plasma_exciter", amount: 4 }], outputs: [{ itemId: "logistics_vessel", amount: 1 }] },
  space_warper: { id: "space_warper", name: "空间翘曲器", buildingId: "assembling_machine_mk1", duration: 10, requiredTechId: "space_warp", inputs: [{ itemId: "graviton_lens", amount: 1 }], outputs: [{ itemId: "space_warper", amount: 1 }] },
  space_warper_from_gravity_matrix: { id: "space_warper_from_gravity_matrix", name: "引力矩阵制空间翘曲器", buildingId: "assembling_machine_mk1", duration: 10, requiredTechId: "space_warp", recursivePriority: 100, inputs: [{ itemId: "gravity_matrix", amount: 1 }], outputs: [{ itemId: "space_warper", amount: 8 }] },
  accumulator: { id: "accumulator", name: "蓄电器", buildingId: "assembling_machine_mk1", duration: 5, requiredTechId: "energy_storage", inputs: [{ itemId: "iron_ingot", amount: 6 }, { itemId: "magnetic_coil", amount: 6 }, { itemId: "circuit_board", amount: 4 }], outputs: [{ itemId: "accumulator", amount: 1 }] },
  accumulator_charge: { id: "accumulator_charge", name: "蓄电器充电", buildingId: "energy_exchanger", duration: 2, requiredTechId: "energy_storage", inputs: [{ itemId: "accumulator", amount: 1 }], outputs: [{ itemId: "charged_accumulator", amount: 1 }] },
  accumulator_discharge: { id: "accumulator_discharge", name: "蓄电器放电", buildingId: "energy_exchanger", duration: 2, requiredTechId: "energy_storage", inputs: [{ itemId: "charged_accumulator", amount: 1 }], outputs: [{ itemId: "accumulator", amount: 1 }] },
  hydrogen_fuel_rod: { id: "hydrogen_fuel_rod", name: "氢燃料棒", buildingId: "assembling_machine_mk1", duration: 6, requiredTechId: "fractionation", inputs: [{ itemId: "titanium_ingot", amount: 1 }, { itemId: "hydrogen", amount: 10 }], outputs: [{ itemId: "hydrogen_fuel_rod", amount: 2 }] },
  deuterium_fractionation: { id: "deuterium_fractionation", name: "氢分馏", buildingId: "fractionator", duration: 1, requiredTechId: "fractionation", inputs: [{ itemId: "hydrogen", amount: 10 }], outputs: [{ itemId: "hydrogen", amount: 9 }, { itemId: "deuterium", amount: 1 }] },
  graphene: { id: "graphene", name: "石墨烯", buildingId: "chemical_plant", duration: 3, requiredTechId: "nanomaterials", inputs: [{ itemId: "energetic_graphite", amount: 3 }, { itemId: "sulfuric_acid", amount: 1 }], outputs: [{ itemId: "graphene", amount: 2 }] },
  graphene_from_fire_ice: { id: "graphene_from_fire_ice", name: "可燃冰裂解", buildingId: "chemical_plant", duration: 2, requiredTechId: "rare_resource_utilization", recursivePriority: 100, inputs: [{ itemId: "fire_ice", amount: 2 }], outputs: [{ itemId: "graphene", amount: 2 }, { itemId: "hydrogen", amount: 1 }] },
  carbon_nanotube: { id: "carbon_nanotube", name: "碳纳米管", buildingId: "chemical_plant", duration: 4, requiredTechId: "nanomaterials", inputs: [{ itemId: "graphene", amount: 3 }, { itemId: "titanium_ingot", amount: 1 }], outputs: [{ itemId: "carbon_nanotube", amount: 2 }] },
  carbon_nanotube_from_spiniform: { id: "carbon_nanotube_from_spiniform", name: "刺笋结晶制碳纳米管", buildingId: "chemical_plant", duration: 4, requiredTechId: "rare_resource_utilization", recursivePriority: 100, inputs: [{ itemId: "spiniform_stalagmite_crystal", amount: 6 }], outputs: [{ itemId: "carbon_nanotube", amount: 2 }] },
  proliferator_mk1: { id: "proliferator_mk1", name: "增产剂 Mk.I", buildingId: "assembling_machine_mk1", duration: 0.5, requiredTechId: "proliferator_1", inputs: [{ itemId: "coal", amount: 1 }], outputs: [{ itemId: "proliferator_mk1", amount: 1 }] },
  proliferator_mk2: { id: "proliferator_mk2", name: "增产剂 Mk.II", buildingId: "assembling_machine_mk1", duration: 1, requiredTechId: "proliferator_2", inputs: [{ itemId: "proliferator_mk1", amount: 2 }, { itemId: "diamond", amount: 1 }], outputs: [{ itemId: "proliferator_mk2", amount: 1 }] },
  proliferator_mk3: { id: "proliferator_mk3", name: "增产剂 Mk.III", buildingId: "assembling_machine_mk1", duration: 2, requiredTechId: "proliferator_3", inputs: [{ itemId: "proliferator_mk2", amount: 2 }, { itemId: "carbon_nanotube", amount: 1 }], outputs: [{ itemId: "proliferator_mk3", amount: 1 }] },
  crystal_silicon: { id: "crystal_silicon", name: "晶格硅", buildingId: "arc_smelter", duration: 2, requiredTechId: "nanomaterials", inputs: [{ itemId: "high_purity_silicon", amount: 1 }], outputs: [{ itemId: "crystal_silicon", amount: 1 }] },
  crystal_silicon_from_fractal: { id: "crystal_silicon_from_fractal", name: "分形硅晶格化", buildingId: "arc_smelter", duration: 1.5, requiredTechId: "rare_resource_utilization", recursivePriority: 100, inputs: [{ itemId: "fractal_silicon", amount: 1 }], outputs: [{ itemId: "crystal_silicon", amount: 2 }] },
  particle_broadband: { id: "particle_broadband", name: "粒子宽带", buildingId: "assembling_machine_mk1", duration: 8, requiredTechId: "information_matrix", inputs: [{ itemId: "carbon_nanotube", amount: 2 }, { itemId: "crystal_silicon", amount: 2 }, { itemId: "plastic", amount: 1 }], outputs: [{ itemId: "particle_broadband", amount: 1 }] },
  electric_motor: { id: "electric_motor", name: "电动机", buildingId: "assembling_machine_mk1", duration: 2, requiredTechId: "basic_logistics", inputs: [{ itemId: "iron_ingot", amount: 2 }, { itemId: "gear", amount: 1 }, { itemId: "magnetic_coil", amount: 1 }], outputs: [{ itemId: "electric_motor", amount: 1 }] },
  electromagnetic_turbine: { id: "electromagnetic_turbine", name: "电磁涡轮", buildingId: "assembling_machine_mk1", duration: 2, requiredTechId: "high_speed_logistics", inputs: [{ itemId: "electric_motor", amount: 2 }, { itemId: "magnetic_coil", amount: 2 }], outputs: [{ itemId: "electromagnetic_turbine", amount: 1 }] },
  super_magnetic_ring: { id: "super_magnetic_ring", name: "超级磁场环", buildingId: "assembling_machine_mk1", duration: 3, requiredTechId: "miniature_particle_collider", inputs: [{ itemId: "electromagnetic_turbine", amount: 2 }, { itemId: "magnet", amount: 3 }, { itemId: "energetic_graphite", amount: 1 }], outputs: [{ itemId: "super_magnetic_ring", amount: 1 }] },
  particle_container: { id: "particle_container", name: "粒子容器", buildingId: "assembling_machine_mk1", duration: 4, requiredTechId: "miniature_particle_collider", inputs: [{ itemId: "electromagnetic_turbine", amount: 2 }, { itemId: "copper_ingot", amount: 2 }, { itemId: "graphene", amount: 2 }], outputs: [{ itemId: "particle_container", amount: 1 }] },
  particle_container_from_unipolar: { id: "particle_container_from_unipolar", name: "单极磁石粒子容器", buildingId: "assembling_machine_mk1", duration: 4, requiredTechId: "rare_resource_utilization", recursivePriority: 100, inputs: [{ itemId: "unipolar_magnet", amount: 10 }, { itemId: "copper_ingot", amount: 2 }], outputs: [{ itemId: "particle_container", amount: 1 }] },
  deuterium: { id: "deuterium", name: "氘富集", buildingId: "miniature_particle_collider", duration: 5, requiredTechId: "miniature_particle_collider", inputs: [{ itemId: "hydrogen", amount: 10 }], outputs: [{ itemId: "deuterium", amount: 5 }] },
  deuteron_fuel_rod: { id: "deuteron_fuel_rod", name: "氘核燃料棒", buildingId: "assembling_machine_mk1", duration: 6, requiredTechId: "miniature_particle_collider", inputs: [{ itemId: "titanium_alloy", amount: 1 }, { itemId: "deuterium", amount: 20 }, { itemId: "super_magnetic_ring", amount: 1 }], outputs: [{ itemId: "deuteron_fuel_rod", amount: 2 }] },
  titanium_glass: { id: "titanium_glass", name: "钛化玻璃", buildingId: "assembling_machine_mk1", duration: 5, requiredTechId: "quantum_chip", inputs: [{ itemId: "glass", amount: 2 }, { itemId: "titanium_ingot", amount: 2 }, { itemId: "water", amount: 2 }], outputs: [{ itemId: "titanium_glass", amount: 2 }] },
  casimir_crystal: { id: "casimir_crystal", name: "卡西米尔晶体", buildingId: "assembling_machine_mk1", duration: 4, requiredTechId: "quantum_chip", inputs: [{ itemId: "titanium_crystal", amount: 1 }, { itemId: "graphene", amount: 2 }, { itemId: "hydrogen", amount: 12 }], outputs: [{ itemId: "casimir_crystal", amount: 1 }] },
  casimir_crystal_advanced: { id: "casimir_crystal_advanced", name: "高效卡西米尔晶体", buildingId: "assembling_machine_mk1", duration: 4, requiredTechId: "rare_resource_utilization", recursivePriority: 100, inputs: [{ itemId: "optical_grating_crystal", amount: 4 }, { itemId: "graphene", amount: 2 }, { itemId: "hydrogen", amount: 12 }], outputs: [{ itemId: "casimir_crystal", amount: 1 }] },
  plane_filter: { id: "plane_filter", name: "位面过滤器", buildingId: "assembling_machine_mk1", duration: 12, requiredTechId: "quantum_chip", inputs: [{ itemId: "casimir_crystal", amount: 1 }, { itemId: "titanium_glass", amount: 2 }], outputs: [{ itemId: "plane_filter", amount: 1 }] },
  quantum_chip: { id: "quantum_chip", name: "量子芯片", buildingId: "assembling_machine_mk1", duration: 6, requiredTechId: "quantum_chip", inputs: [{ itemId: "processor", amount: 2 }, { itemId: "plane_filter", amount: 2 }], outputs: [{ itemId: "quantum_chip", amount: 1 }] },
  strange_matter: { id: "strange_matter", name: "奇异物质", buildingId: "miniature_particle_collider", duration: 8, requiredTechId: "gravity_matrix", inputs: [{ itemId: "particle_container", amount: 2 }, { itemId: "iron_ingot", amount: 2 }, { itemId: "deuterium", amount: 10 }], outputs: [{ itemId: "strange_matter", amount: 1 }] },
  graviton_lens: { id: "graviton_lens", name: "引力透镜", buildingId: "assembling_machine_mk1", duration: 6, requiredTechId: "gravity_matrix", inputs: [{ itemId: "diamond", amount: 4 }, { itemId: "strange_matter", amount: 1 }], outputs: [{ itemId: "graviton_lens", amount: 1 }] },
  photon_combiner: { id: "photon_combiner", name: "光子合并器", buildingId: "assembling_machine_mk1", duration: 3, requiredTechId: "dyson_swarm", inputs: [{ itemId: "prism", amount: 2 }, { itemId: "circuit_board", amount: 1 }], outputs: [{ itemId: "photon_combiner", amount: 1 }] },
  photon_combiner_from_grating: { id: "photon_combiner_from_grating", name: "光栅石光子合并器", buildingId: "assembling_machine_mk1", duration: 3, requiredTechId: "rare_resource_utilization", recursivePriority: 100, inputs: [{ itemId: "optical_grating_crystal", amount: 1 }, { itemId: "circuit_board", amount: 1 }], outputs: [{ itemId: "photon_combiner", amount: 1 }] },
  solar_sail: { id: "solar_sail", name: "太阳帆", buildingId: "assembling_machine_mk1", duration: 4, requiredTechId: "dyson_swarm", inputs: [{ itemId: "graphene", amount: 1 }, { itemId: "photon_combiner", amount: 1 }], outputs: [{ itemId: "solar_sail", amount: 2 }] },
  solar_sail_launch: { id: "solar_sail_launch", name: "太阳帆发射", buildingId: "em_rail_ejector", duration: 12, requiredTechId: "dyson_swarm", inputs: [{ itemId: "solar_sail", amount: 1 }], outputs: [] },
  ray_power: { id: "ray_power", name: "电力接收", buildingId: "ray_receiver", duration: 1, requiredTechId: "ray_receiver", inputs: [], outputs: [] },
  critical_photon: { id: "critical_photon", name: "临界光子", buildingId: "ray_receiver", duration: 10, requiredTechId: "ray_receiver", inputs: [], outputs: [{ itemId: "critical_photon", amount: 1 }] },
  antimatter: { id: "antimatter", name: "质能转换", buildingId: "miniature_particle_collider", duration: 2, requiredTechId: "antimatter", inputs: [{ itemId: "critical_photon", amount: 2 }], outputs: [{ itemId: "hydrogen", amount: 2 }, { itemId: "antimatter", amount: 2 }] },
  annihilation_constraint_sphere: { id: "annihilation_constraint_sphere", name: "湮灭约束球", buildingId: "assembling_machine_mk1", duration: 20, requiredTechId: "antimatter", inputs: [{ itemId: "particle_container", amount: 1 }, { itemId: "processor", amount: 1 }], outputs: [{ itemId: "annihilation_constraint_sphere", amount: 1 }] },
  antimatter_fuel_rod: { id: "antimatter_fuel_rod", name: "反物质燃料棒", buildingId: "assembling_machine_mk1", duration: 12, requiredTechId: "antimatter", inputs: [{ itemId: "antimatter", amount: 10 }, { itemId: "hydrogen", amount: 10 }, { itemId: "annihilation_constraint_sphere", amount: 1 }, { itemId: "titanium_alloy", amount: 1 }], outputs: [{ itemId: "antimatter_fuel_rod", amount: 2 }] },
  frame_material: { id: "frame_material", name: "框架材料", buildingId: "assembling_machine_mk1", duration: 6, requiredTechId: "dyson_sphere_program", inputs: [{ itemId: "carbon_nanotube", amount: 4 }, { itemId: "titanium_alloy", amount: 1 }, { itemId: "high_purity_silicon", amount: 1 }], outputs: [{ itemId: "frame_material", amount: 1 }] },
  dyson_sphere_component: { id: "dyson_sphere_component", name: "戴森球组件", buildingId: "assembling_machine_mk1", duration: 8, requiredTechId: "dyson_sphere_program", inputs: [{ itemId: "frame_material", amount: 3 }, { itemId: "solar_sail", amount: 3 }, { itemId: "processor", amount: 3 }], outputs: [{ itemId: "dyson_sphere_component", amount: 1 }] },
  small_carrier_rocket: { id: "small_carrier_rocket", name: "小型运载火箭", buildingId: "assembling_machine_mk1", duration: 6, requiredTechId: "vertical_launching_silo", inputs: [{ itemId: "dyson_sphere_component", amount: 2 }, { itemId: "deuteron_fuel_rod", amount: 4 }, { itemId: "quantum_chip", amount: 2 }], outputs: [{ itemId: "small_carrier_rocket", amount: 1 }] },
  carrier_rocket_launch: { id: "carrier_rocket_launch", name: "运载火箭发射", buildingId: "vertical_launching_silo", duration: 6, requiredTechId: "vertical_launching_silo", inputs: [{ itemId: "small_carrier_rocket", amount: 1 }], outputs: [] },
  diamond: { id: "diamond", name: "金刚石", buildingId: "arc_smelter", duration: 2, requiredTechId: "high_strength_crystal", inputs: [{ itemId: "energetic_graphite", amount: 1 }], outputs: [{ itemId: "diamond", amount: 1 }] },
  diamond_from_kimberlite: { id: "diamond_from_kimberlite", name: "金伯利矿提炼", buildingId: "arc_smelter", duration: 1.5, requiredTechId: "rare_resource_utilization", recursivePriority: 100, inputs: [{ itemId: "kimberlite_ore", amount: 1 }], outputs: [{ itemId: "diamond", amount: 2 }] },
  plastic: { id: "plastic", name: "塑料", buildingId: "chemical_plant", duration: 3, requiredTechId: "basic_chemical_engineering", inputs: [{ itemId: "refined_oil", amount: 2 }, { itemId: "energetic_graphite", amount: 1 }], outputs: [{ itemId: "plastic", amount: 1 }] },
  organic_crystal: { id: "organic_crystal", name: "有机晶体", buildingId: "chemical_plant", duration: 6, requiredTechId: "polymer_chemistry", inputs: [{ itemId: "plastic", amount: 2 }, { itemId: "refined_oil", amount: 1 }, { itemId: "water", amount: 1 }], outputs: [{ itemId: "organic_crystal", amount: 1 }] },
  titanium_crystal: { id: "titanium_crystal", name: "钛晶石", buildingId: "assembling_machine_mk1", duration: 4, requiredTechId: "structure_matrix", inputs: [{ itemId: "titanium_ingot", amount: 3 }, { itemId: "organic_crystal", amount: 1 }], outputs: [{ itemId: "titanium_crystal", amount: 1 }] },
  electromagnetic_matrix: { id: "electromagnetic_matrix", name: "电磁矩阵", buildingId: "matrix_lab", duration: 3, inputs: [{ itemId: "magnetic_coil", amount: 1 }, { itemId: "circuit_board", amount: 1 }], outputs: [{ itemId: "electromagnetic_matrix", amount: 1 }] },
  energy_matrix: { id: "energy_matrix", name: "能量矩阵", buildingId: "matrix_lab", duration: 6, requiredTechId: "energy_matrix", inputs: [{ itemId: "energetic_graphite", amount: 2 }, { itemId: "hydrogen", amount: 2 }], outputs: [{ itemId: "energy_matrix", amount: 1 }] },
  structure_matrix: { id: "structure_matrix", name: "结构矩阵", buildingId: "matrix_lab", duration: 8, requiredTechId: "structure_matrix", inputs: [{ itemId: "diamond", amount: 1 }, { itemId: "titanium_crystal", amount: 1 }], outputs: [{ itemId: "structure_matrix", amount: 1 }] },
  information_matrix: { id: "information_matrix", name: "信息矩阵", buildingId: "matrix_lab", duration: 10, requiredTechId: "information_matrix", inputs: [{ itemId: "particle_broadband", amount: 1 }, { itemId: "processor", amount: 2 }], outputs: [{ itemId: "information_matrix", amount: 1 }] },
  gravity_matrix: { id: "gravity_matrix", name: "引力矩阵", buildingId: "matrix_lab", duration: 24, requiredTechId: "gravity_matrix", inputs: [{ itemId: "graviton_lens", amount: 1 }, { itemId: "quantum_chip", amount: 1 }], outputs: [{ itemId: "gravity_matrix", amount: 2 }] },
  universe_matrix: { id: "universe_matrix", name: "宇宙矩阵", buildingId: "matrix_lab", duration: 15, requiredTechId: "universe_matrix", inputs: [{ itemId: "electromagnetic_matrix", amount: 1 }, { itemId: "energy_matrix", amount: 1 }, { itemId: "structure_matrix", amount: 1 }, { itemId: "information_matrix", amount: 1 }, { itemId: "gravity_matrix", amount: 1 }, { itemId: "antimatter", amount: 1 }], outputs: [{ itemId: "universe_matrix", amount: 1 }] },
  matrix_research: { id: "matrix_research", name: "科研模式", buildingId: "matrix_lab", duration: 3, inputs: [], outputs: [] },
};

export const RECIPES_BY_BUILDING = Object.values(RECIPES).reduce(
  (groups, recipe) => {
    (groups[recipe.buildingId] ??= []).push(recipe);
    return groups;
  },
  {} as Partial<Record<BuildingId, RecipeDefinition[]>>,
);

const RECIPE_BUILDING_BASE: Partial<Record<BuildingId, BuildingId>> = {
  assembling_machine_mk2: "assembling_machine_mk1",
  assembling_machine_mk3: "assembling_machine_mk1",
  plane_smelter: "arc_smelter",
  quantum_chemical_plant: "chemical_plant",
};

export const BUILDING_UPGRADES: Partial<Record<BuildingId, BuildingId>> = {
  assembling_machine_mk1: "assembling_machine_mk2",
  assembling_machine_mk2: "assembling_machine_mk3",
  arc_smelter: "plane_smelter",
  chemical_plant: "quantum_chemical_plant",
};

export interface RuntimeBeltDefinition {
  id: ConveyorBeltId;
  tier: BeltTier;
  speed: number;
  name: string;
}

const CORE_BELT_DEFINITIONS: RuntimeBeltDefinition[] = [
  { id: "conveyor_belt_mk1", tier: 1, speed: 6, name: "传送带 Mk.I" },
  { id: "conveyor_belt_mk2", tier: 2, speed: 12, name: "传送带 Mk.II" },
  { id: "conveyor_belt_mk3", tier: 3, speed: 30, name: "传送带 Mk.III" },
];
const RUNTIME_BELT_DEFINITIONS = new Map<number, RuntimeBeltDefinition>(CORE_BELT_DEFINITIONS.map((definition) => [definition.tier, definition]));

export function resetRuntimeBeltDefinitions(): void {
  RUNTIME_BELT_DEFINITIONS.clear();
  for (const definition of CORE_BELT_DEFINITIONS) RUNTIME_BELT_DEFINITIONS.set(definition.tier, { ...definition });
}

export function registerRuntimeBeltDefinition(definition: RuntimeBeltDefinition): boolean {
  if (!Number.isInteger(definition.tier) || definition.tier < 4 || definition.tier > 32 ||
    !Number.isFinite(definition.speed) || definition.speed <= 0 || RUNTIME_BELT_DEFINITIONS.has(definition.tier) ||
    [...RUNTIME_BELT_DEFINITIONS.values()].some((entry) => entry.id === definition.id)) return false;
  RUNTIME_BELT_DEFINITIONS.set(definition.tier, { ...definition });
  return true;
}

export function getBeltTiers(): BeltTier[] {
  return [...RUNTIME_BELT_DEFINITIONS.keys()].sort((left, right) => left - right);
}

export function isRegisteredBeltTier(tier: unknown): tier is BeltTier {
  return typeof tier === "number" && Number.isInteger(tier) && RUNTIME_BELT_DEFINITIONS.has(tier);
}

export function getBeltSpeed(tier: BeltTier): number {
  return RUNTIME_BELT_DEFINITIONS.get(tier)?.speed ?? 0;
}

export function getNextBeltTier(tier: BeltTier): BeltTier | null {
  return getBeltTiers().find((candidate) => candidate > tier) ?? null;
}

export const SORTER_CONSTRUCTION_BY_TIER: Record<SorterTier, SorterId> = {
  1: "sorter_mk1",
  2: "sorter_mk2",
  3: "sorter_mk3",
};

export function getRecipesForBuilding(buildingId: BuildingId): RecipeDefinition[] {
  // Content packs can add recipes at runtime. Keep the exported static index for
  // core-data consumers, but resolve this lookup from the live registry. A
  // declarative building family is a capability contract: pack-provided
  // smelters/assemblers/chemical plants receive the same generic recipes as
  // their core counterparts without duplicating hundreds of definitions.
  return Object.values(RECIPES).filter((recipe) => buildingSupportsRecipe(buildingId, recipe));
}

export function buildingSupportsRecipe(buildingId: BuildingId, recipe: RecipeDefinition): boolean {
  if ((RECIPE_BUILDING_BASE[buildingId] ?? buildingId) === recipe.buildingId) return true;
  const family = BUILDINGS[buildingId]?.family;
  return Boolean(family && BUILDINGS[recipe.buildingId]?.family === family);
}

export function getBuildingUpgradeTarget(buildingId: BuildingId): BuildingId | undefined {
  return BUILDING_UPGRADES[buildingId];
}

export function getBeltConstructionId(tier: BeltTier): ConveyorBeltId {
  return RUNTIME_BELT_DEFINITIONS.get(tier)?.id ?? `unknown_conveyor_belt_tier_${tier}`;
}

export function getBeltTier(id: ConveyorBeltId): BeltTier {
  return [...RUNTIME_BELT_DEFINITIONS.values()].find((definition) => definition.id === id)?.tier ?? 1;
}

export function getSorterConstructionId(tier: SorterTier): SorterId {
  return SORTER_CONSTRUCTION_BY_TIER[tier];
}

export function getSorterTier(id: SorterId): SorterTier {
  return id === "sorter_mk3" ? 3 : id === "sorter_mk2" ? 2 : 1;
}

export function isConveyorBeltId(id: ConstructionId): boolean {
  return [...RUNTIME_BELT_DEFINITIONS.values()].some((definition) => definition.id === id);
}

export function isSorterId(id: ConstructionId): id is SorterId {
  return id === "sorter_mk1" || id === "sorter_mk2" || id === "sorter_mk3";
}

export const CONSTRUCTION: ConstructionDefinition[] = [
  { buildingId: "wind_turbine", name: "风力涡轮机", outputAmount: 1, requiredTechId: "electromagnetism", costs: [{ itemId: "iron_ingot", amount: 6 }, { itemId: "gear", amount: 1 }, { itemId: "magnetic_coil", amount: 3 }] },
  { buildingId: "solar_panel", name: "太阳能板", outputAmount: 1, requiredTechId: "solar_energy", costs: [{ itemId: "copper_ingot", amount: 10 }, { itemId: "high_purity_silicon", amount: 10 }, { itemId: "circuit_board", amount: 5 }] },
  { buildingId: "geothermal_power_station", name: "地热发电站", outputAmount: 1, requiredTechId: "geothermal_power", costs: [{ itemId: "steel", amount: 15 }, { itemId: "titanium_alloy", amount: 8 }, { itemId: "processor", amount: 4 }] },
  { buildingId: "thermal_power_plant", name: "火力发电厂", outputAmount: 1, requiredTechId: "thermal_power", costs: [{ itemId: "iron_ingot", amount: 10 }, { itemId: "stone_brick", amount: 4 }, { itemId: "gear", amount: 4 }, { itemId: "magnetic_coil", amount: 4 }] },
  { buildingId: "mini_fusion_power_plant", name: "微型聚变发电站", outputAmount: 1, requiredTechId: "fusion_power", costs: [{ itemId: "titanium_alloy", amount: 12 }, { itemId: "super_magnetic_ring", amount: 10 }, { itemId: "carbon_nanotube", amount: 8 }, { itemId: "processor", amount: 4 }] },
  { buildingId: "artificial_star", name: "人造恒星", outputAmount: 1, requiredTechId: "artificial_star", costs: [{ itemId: "titanium_alloy", amount: 20 }, { itemId: "frame_material", amount: 20 }, { itemId: "annihilation_constraint_sphere", amount: 10 }, { itemId: "quantum_chip", amount: 10 }] },
  { buildingId: "accumulator", name: "蓄电器", outputAmount: 1, requiredTechId: "energy_storage", costs: [{ itemId: "iron_ingot", amount: 6 }, { itemId: "magnetic_coil", amount: 6 }, { itemId: "circuit_board", amount: 4 }] },
  { buildingId: "energy_exchanger", name: "能量枢纽", outputAmount: 1, requiredTechId: "energy_storage", costs: [{ itemId: "steel", amount: 40 }, { itemId: "titanium_alloy", amount: 40 }, { itemId: "processor", amount: 40 }, { itemId: "particle_container", amount: 8 }] },
  { buildingId: "mining_machine", name: "采矿机", outputAmount: 1, costs: [{ itemId: "iron_ingot", amount: 4 }, { itemId: "circuit_board", amount: 2 }, { itemId: "magnetic_coil", amount: 2 }, { itemId: "gear", amount: 2 }] },
  { buildingId: "arc_smelter", name: "电弧熔炉", outputAmount: 1, costs: [{ itemId: "iron_ingot", amount: 4 }, { itemId: "stone_brick", amount: 2 }, { itemId: "circuit_board", amount: 4 }, { itemId: "magnetic_coil", amount: 2 }] },
  { buildingId: "plane_smelter", name: "位面熔炉", outputAmount: 1, requiredTechId: "plane_smelting", costs: [{ itemId: "titanium_alloy", amount: 15 }, { itemId: "processor", amount: 8 }, { itemId: "super_magnetic_ring", amount: 4 }, { itemId: "plane_filter", amount: 4 }] },
  { buildingId: "assembling_machine_mk1", name: "制造台 Mk.I", outputAmount: 1, costs: [{ itemId: "iron_ingot", amount: 4 }, { itemId: "gear", amount: 8 }, { itemId: "circuit_board", amount: 4 }] },
  { buildingId: "assembling_machine_mk2", name: "制造台 Mk.II", outputAmount: 1, requiredTechId: "high_speed_assembling", costs: [{ itemId: "steel", amount: 8 }, { itemId: "gear", amount: 8 }, { itemId: "circuit_board", amount: 8 }, { itemId: "magnetic_coil", amount: 4 }] },
  { buildingId: "assembling_machine_mk3", name: "制造台 Mk.III", outputAmount: 1, requiredTechId: "quantum_printing", costs: [{ itemId: "titanium_alloy", amount: 8 }, { itemId: "particle_broadband", amount: 8 }, { itemId: "quantum_chip", amount: 4 }] },
  { buildingId: "spray_coater", name: "喷涂机", outputAmount: 1, requiredTechId: "proliferator_1", costs: [{ itemId: "steel", amount: 4 }, { itemId: "circuit_board", amount: 4 }, { itemId: "plasma_exciter", amount: 2 }] },
  { buildingId: "matrix_lab", name: "矩阵研究站", outputAmount: 1, requiredTechId: "electromagnetic_matrix", costs: [{ itemId: "iron_ingot", amount: 8 }, { itemId: "glass", amount: 4 }, { itemId: "circuit_board", amount: 4 }, { itemId: "magnetic_coil", amount: 4 }] },
  { buildingId: "conveyor_belt_mk1", name: "传送带 Mk.I", outputAmount: 3, requiredTechId: "basic_logistics", costs: [{ itemId: "iron_ingot", amount: 2 }, { itemId: "gear", amount: 1 }] },
  { buildingId: "conveyor_belt_mk2", name: "传送带 Mk.II", outputAmount: 3, requiredTechId: "high_speed_logistics", costs: [{ itemId: "iron_ingot", amount: 2 }, { itemId: "gear", amount: 1 }, { itemId: "magnetic_coil", amount: 2 }] },
  { buildingId: "conveyor_belt_mk3", name: "传送带 Mk.III", outputAmount: 3, requiredTechId: "super_magnetic_logistics", costs: [{ itemId: "graphene", amount: 2 }, { itemId: "electromagnetic_turbine", amount: 2 }, { itemId: "super_magnetic_ring", amount: 1 }] },
  { buildingId: "storage_mk1", name: "小型储物仓", outputAmount: 1, requiredTechId: "basic_logistics", costs: [{ itemId: "iron_ingot", amount: 4 }, { itemId: "stone_brick", amount: 4 }] },
  { buildingId: "material_delivery_hub", name: "物资配送枢纽", outputAmount: 1, requiredTechId: "material_delivery_logistics", costs: [{ itemId: "steel", amount: 40 }, { itemId: "titanium_ingot", amount: 20 }, { itemId: "processor", amount: 10 }, { itemId: "electric_motor", amount: 10 }] },
  { buildingId: "orbital_cargo_terminal", name: "轨道货运终端", outputAmount: 1, requiredTechId: "universe_matrix", costs: [{ itemId: "titanium_alloy", amount: 500 }, { itemId: "frame_material", amount: 200 }, { itemId: "quantum_chip", amount: 200 }, { itemId: "processor", amount: 500 }] },
  { buildingId: "splitter_4way", name: "四向分流器", outputAmount: 1, requiredTechId: "basic_logistics", costs: [{ itemId: "iron_ingot", amount: 3 }, { itemId: "gear", amount: 2 }, { itemId: "circuit_board", amount: 1 }] },
  { buildingId: "storage_tank", name: "储液罐", outputAmount: 1, requiredTechId: "high_efficiency_plasma_control", costs: [{ itemId: "iron_ingot", amount: 8 }, { itemId: "stone_brick", amount: 4 }, { itemId: "glass", amount: 4 }] },
  { buildingId: "oil_extractor", name: "原油萃取站", outputAmount: 1, requiredTechId: "high_efficiency_plasma_control", costs: [{ itemId: "steel", amount: 12 }, { itemId: "stone_brick", amount: 12 }, { itemId: "circuit_board", amount: 6 }, { itemId: "plasma_exciter", amount: 4 }] },
  { buildingId: "oil_refinery", name: "原油精炼厂", outputAmount: 1, requiredTechId: "high_efficiency_plasma_control", costs: [{ itemId: "steel", amount: 10 }, { itemId: "stone_brick", amount: 10 }, { itemId: "circuit_board", amount: 6 }, { itemId: "plasma_exciter", amount: 6 }] },
  { buildingId: "water_pump", name: "抽水站", outputAmount: 1, requiredTechId: "basic_chemical_engineering", costs: [{ itemId: "iron_ingot", amount: 4 }, { itemId: "stone_brick", amount: 8 }, { itemId: "circuit_board", amount: 2 }, { itemId: "magnetic_coil", amount: 2 }] },
  { buildingId: "chemical_plant", name: "化工厂", outputAmount: 1, requiredTechId: "basic_chemical_engineering", costs: [{ itemId: "steel", amount: 8 }, { itemId: "stone_brick", amount: 8 }, { itemId: "glass", amount: 8 }, { itemId: "circuit_board", amount: 4 }] },
  { buildingId: "quantum_chemical_plant", name: "量子化工厂", outputAmount: 1, requiredTechId: "quantum_chemical_engineering", costs: [{ itemId: "titanium_alloy", amount: 10 }, { itemId: "graphene", amount: 20 }, { itemId: "processor", amount: 10 }, { itemId: "plane_filter", amount: 4 }] },
  { buildingId: "fractionator", name: "分馏塔", outputAmount: 1, requiredTechId: "fractionation", costs: [{ itemId: "steel", amount: 8 }, { itemId: "stone_brick", amount: 4 }, { itemId: "glass", amount: 4 }, { itemId: "processor", amount: 1 }] },
  { buildingId: "miniature_particle_collider", name: "微型粒子对撞机", outputAmount: 1, requiredTechId: "miniature_particle_collider", costs: [{ itemId: "titanium_alloy", amount: 20 }, { itemId: "processor", amount: 20 }, { itemId: "super_magnetic_ring", amount: 20 }, { itemId: "graphene", amount: 20 }] },
  { buildingId: "em_rail_ejector", name: "电磁轨道弹射器", outputAmount: 1, requiredTechId: "dyson_swarm", costs: [{ itemId: "steel", amount: 20 }, { itemId: "gear", amount: 20 }, { itemId: "processor", amount: 5 }, { itemId: "super_magnetic_ring", amount: 10 }] },
  { buildingId: "ray_receiver", name: "射线接收站", outputAmount: 1, requiredTechId: "ray_receiver", costs: [{ itemId: "steel", amount: 20 }, { itemId: "high_purity_silicon", amount: 20 }, { itemId: "photon_combiner", amount: 10 }, { itemId: "processor", amount: 5 }] },
  { buildingId: "vertical_launching_silo", name: "垂直发射井", outputAmount: 1, requiredTechId: "vertical_launching_silo", costs: [{ itemId: "steel", amount: 80 }, { itemId: "titanium_alloy", amount: 80 }, { itemId: "frame_material", amount: 30 }, { itemId: "graviton_lens", amount: 20 }, { itemId: "quantum_chip", amount: 10 }] },
  { buildingId: "planetary_logistics_station", name: "行星物流站", outputAmount: 1, requiredTechId: "planetary_logistics", costs: [{ itemId: "steel", amount: 20 }, { itemId: "titanium_ingot", amount: 20 }, { itemId: "processor", amount: 10 }] },
  { buildingId: "interstellar_logistics_station", name: "星际物流站", outputAmount: 1, requiredTechId: "interstellar_logistics", costs: [{ itemId: "steel", amount: 30 }, { itemId: "titanium_alloy", amount: 40 }, { itemId: "processor", amount: 20 }] },
  { buildingId: "orbital_collector", name: "轨道采集器", outputAmount: 1, requiredTechId: "orbital_collection", costs: [{ itemId: "titanium_alloy", amount: 40 }, { itemId: "super_magnetic_ring", amount: 20 }, { itemId: "graphene", amount: 20 }] },
  { buildingId: "construction_center", name: "建筑制造中心", outputAmount: 1, requiredTechId: "construction_automation", costs: [{ itemId: "steel", amount: 5000 }, { itemId: "titanium_alloy", amount: 5000 }, { itemId: "processor", amount: 5000 }, { itemId: "particle_broadband", amount: 5000 }] },
  { buildingId: "galactic_material_exporter", name: "超大型物资出口", outputAmount: 1, requiredTechId: "universe_matrix", costs: [{ itemId: "universe_matrix", amount: 1000 }, { itemId: "small_carrier_rocket", amount: 500 }, { itemId: "frame_material", amount: 1000 }, { itemId: "quantum_chip", amount: 1000 }] },
  { buildingId: "micro_black_hole_connector", name: "微型黑洞连接装置", outputAmount: 1, requiredTechId: "micro_black_hole_containment", costs: [{ itemId: "universe_matrix", amount: 12000 }, { itemId: "frame_material", amount: 7500 }, { itemId: "quantum_chip", amount: 6000 }, { itemId: "antimatter_fuel_rod", amount: 4500 }] },
  { buildingId: "time_warp_device", name: "时间扭曲装置", outputAmount: 1, requiredTechId: "time_warp_engineering", costs: [{ itemId: "universe_matrix", amount: 60000 }, { itemId: "frame_material", amount: 36000 }, { itemId: "quantum_chip", amount: 30000 }, { itemId: "antimatter_fuel_rod", amount: 24000 }] },
  { buildingId: "space_station_construction_launcher", name: "空间站施工发射平台", outputAmount: 1, requiredTechId: "system_space_station_engineering", costs: [{ itemId: "titanium_alloy", amount: 2000 }, { itemId: "frame_material", amount: 1000 }, { itemId: "quantum_chip", amount: 1000 }, { itemId: "processor", amount: 2000 }] },
];

/**
 * Construction ids that ship with the game.  The array is captured once so
 * runtime content-pack entries appended to CONSTRUCTION can be discovered
 * without changing the ordering of the built-in tray.
 */
const CORE_CONSTRUCTION_IDS: readonly ConstructionId[] = CONSTRUCTION.map((definition) => definition.buildingId);

export type ConstructionCategory = "power" | "production" | "logistics" | "dyson";

const CORE_CONSTRUCTION_CATEGORY_IDS: Record<ConstructionCategory, ReadonlySet<ConstructionId>> = {
  power: new Set(["wind_turbine", "solar_panel", "geothermal_power_station", "thermal_power_plant", "mini_fusion_power_plant", "artificial_star", "accumulator", "energy_exchanger"]),
  production: new Set(["mining_machine", "arc_smelter", "plane_smelter", "assembling_machine_mk1", "assembling_machine_mk2", "assembling_machine_mk3", "spray_coater", "matrix_lab", "oil_extractor", "oil_refinery", "water_pump", "chemical_plant", "quantum_chemical_plant", "fractionator", "miniature_particle_collider", "construction_center"]),
  logistics: new Set(["conveyor_belt_mk1", "conveyor_belt_mk2", "conveyor_belt_mk3", "storage_mk1", "material_delivery_hub", "orbital_cargo_terminal", "splitter_4way", "storage_tank", "planetary_logistics_station", "interstellar_logistics_station", "space_station_construction_launcher", "orbital_collector"]),
  dyson: new Set(["em_rail_ejector", "vertical_launching_silo", "ray_receiver", "galactic_material_exporter", "micro_black_hole_connector", "time_warp_device"]),
};

const CORE_RESOURCE_EXTRACTOR_IDS: ReadonlySet<BuildingId> = new Set([
  "mining_machine",
  "oil_extractor",
  "water_pump",
]);

/** Return the core construction order followed by active runtime additions. */
export function getConstructionCatalogIds(): ConstructionId[] {
  const result: ConstructionId[] = [];
  const seen = new Set<ConstructionId>();
  for (const id of [...CORE_CONSTRUCTION_IDS, ...CONSTRUCTION.map((definition) => definition.buildingId)]) {
    if (seen.has(id)) continue;
    seen.add(id);
    result.push(id);
  }
  return result;
}

/**
 * Whether an entry has a supported placement interaction.  Core extractors
 * are installed on resource veins through their dedicated interaction; a
 * declarative `kind: "miner"` has no resource mapping yet and must not look
 * deployable in a free-coordinate tray.
 */
export function isConstructionDeployable(id: ConstructionId): boolean {
  if (isConveyorBeltId(id)) return true;
  const building = BUILDINGS[id as BuildingId];
  return Boolean(building && (building.kind !== "miner" || CORE_RESOURCE_EXTRACTOR_IDS.has(building.id)));
}

/**
 * Categorize both core and declarative content-pack construction entries.
 * Custom buildings use their safe generic kind; custom belts always belong to
 * logistics.  Dyson-specific behavior remains an explicit core allowlist.
 */
export function isConstructionInCategory(id: ConstructionId, category: ConstructionCategory): boolean {
  if (CORE_CONSTRUCTION_CATEGORY_IDS[category].has(id)) return true;
  if (isConveyorBeltId(id)) return category === "logistics";
  const building = BUILDINGS[id as BuildingId];
  if (!building) return false;
  if (category === "power") return building.kind === "power";
  if (category === "production") return building.kind === "machine" || building.kind === "miner";
  if (category === "logistics") return building.kind === "storage" || building.kind === "splitter" || building.kind === "station";
  return false;
}

export const TECHNOLOGIES: Record<TechId, TechnologyDefinition> = {
  electromagnetic_matrix: {
    id: "electromagnetic_matrix", name: "电磁矩阵", tier: 0, costs: [{ itemId: "electromagnetic_matrix", amount: 3 }], prerequisites: [],
    summary: "建立以电磁矩阵承载研究数据的基础科研体系。",
    unlocks: ["矩阵研究站制造", "蓝色矩阵科研"],
  },
  electromagnetism: {
    id: "electromagnetism", name: "电磁学", tier: 1, costs: [{ itemId: "electromagnetic_matrix", amount: 5 }], prerequisites: ["electromagnetic_matrix"],
    summary: "掌握稳定电磁场与基础风力发电设备的批量制造。",
    unlocks: ["风力涡轮机制造"],
  },
  solar_energy: {
    id: "solar_energy", name: "太阳能收集", tier: 2, costs: [{ itemId: "electromagnetic_matrix", amount: 8 }],
    prerequisites: ["electromagnetism"],
    summary: "将高纯硅光伏阵列接入行星电网，建立无需燃料的日照发电能力。",
    unlocks: ["太阳能板", "行星日照系数"],
  },
  basic_logistics: {
    id: "basic_logistics", name: "基础物流系统", tier: 2, costs: [{ itemId: "electromagnetic_matrix", amount: 8 }], prerequisites: ["electromagnetism"],
    summary: "建立可持续扩建的标准化物料运输线路。",
    unlocks: ["传送带 Mk.I 制造", "小型储物仓", "四向分流器", "电动机"],
  },
  thermal_power: {
    id: "thermal_power", name: "火力发电", tier: 2, costs: [{ itemId: "electromagnetic_matrix", amount: 8 }],
    prerequisites: ["electromagnetism"],
    summary: "把煤与化工燃料转换为可调度电力，为高耗能工业提供稳定能源。",
    unlocks: ["火力发电厂", "多燃料发电", "按需燃烧"],
  },
  high_efficiency_plasma_control: {
    id: "high_efficiency_plasma_control", name: "高效电浆控制", tier: 3, costs: [{ itemId: "electromagnetic_matrix", amount: 12 }],
    prerequisites: ["basic_logistics", "thermal_power"],
    summary: "为原油萃取、等离子精炼与能源矩阵研究建立控制基础。",
    unlocks: ["原油萃取站", "原油精炼厂", "储液罐", "钢材与电浆部件"],
  },
  energy_matrix: {
    id: "energy_matrix", name: "能量矩阵", tier: 4, costs: [{ itemId: "electromagnetic_matrix", amount: 15 }],
    prerequisites: ["high_efficiency_plasma_control"],
    summary: "把氢的能级结构和高能石墨编码为第二种科学矩阵。",
    unlocks: ["高能石墨", "能量矩阵生产", "红色矩阵科研"],
  },
  energy_storage: {
    id: "energy_storage", name: "能量储存", tier: 5,
    costs: [{ itemId: "electromagnetic_matrix", amount: 15 }, { itemId: "energy_matrix", amount: 15 }],
    prerequisites: ["energy_matrix", "basic_logistics"],
    summary: "把电网富余能量封装进可运输蓄电器，并通过能量枢纽在行星间调配电力。",
    unlocks: ["蓄电器", "能量枢纽", "满蓄电器", "自动削峰填谷"],
  },
  fractionation: {
    id: "fractionation", name: "流体分馏", tier: 5,
    costs: [{ itemId: "electromagnetic_matrix", amount: 15 }, { itemId: "energy_matrix", amount: 15 }],
    prerequisites: ["energy_matrix", "high_efficiency_plasma_control"],
    summary: "让氢在闭环物流中反复通过分馏塔，稳定分离氘并制造便于运输的氢燃料棒。",
    unlocks: ["分馏塔", "氢分馏", "氢燃料棒"],
  },
  geothermal_power: {
    id: "geothermal_power", name: "地热发电", tier: 6,
    costs: [{ itemId: "electromagnetic_matrix", amount: 18 }, { itemId: "energy_matrix", amount: 18 }],
    prerequisites: ["energy_storage", "high_efficiency_plasma_control"],
    summary: "利用熔岩行星的高温地幔建立不受日照影响的稳定基础电源。",
    unlocks: ["地热发电站", "烬原 II 熔岩电力"],
  },
  high_speed_assembling: {
    id: "high_speed_assembling", name: "高速装配工艺", tier: 5,
    costs: [{ itemId: "electromagnetic_matrix", amount: 15 }, { itemId: "energy_matrix", amount: 15 }],
    prerequisites: ["energy_matrix"],
    summary: "改进装配设备的定位与驱动机构，让生产节点在原有配方上获得更高吞吐。",
    unlocks: ["制造台 Mk.II", "制造台原地升级"],
  },
  high_speed_logistics: {
    id: "high_speed_logistics", name: "高速物流系统", tier: 5,
    costs: [{ itemId: "electromagnetic_matrix", amount: 15 }, { itemId: "energy_matrix", amount: 15 }],
    prerequisites: ["energy_matrix", "basic_logistics"],
    summary: "以电磁涡轮提高运输线路驱动频率，在相同线路数量下提升物流上限。",
    unlocks: ["传送带 Mk.II", "运输线原地升级", "电磁涡轮"],
  },
  mining_speed_1: {
    id: "mining_speed_1", name: "高效采矿 I", tier: 5,
    costs: [{ itemId: "electromagnetic_matrix", amount: 15 }, { itemId: "energy_matrix", amount: 15 }],
    prerequisites: ["energy_matrix"],
    summary: "优化采矿机切削轨迹和矿脉覆盖，使全部固体采矿节点持续增产。",
    unlocks: ["固体矿物开采速度 +50%"],
  },
  proliferator_1: {
    id: "proliferator_1", name: "增产剂 Mk.I", tier: 6,
    costs: [{ itemId: "electromagnetic_matrix", amount: 20 }, { itemId: "energy_matrix", amount: 20 }],
    prerequisites: ["energy_matrix", "high_speed_assembling", "high_speed_logistics"],
    summary: "将煤加工为可控喷涂介质，并建立生产节点的内联喷涂模块。",
    unlocks: ["增产剂 Mk.I", "喷涂机", "额外产出与加速模式"],
  },
  xray_cracking: {
    id: "xray_cracking", name: "X 射线裂解", tier: 5,
    costs: [{ itemId: "electromagnetic_matrix", amount: 10 }, { itemId: "energy_matrix", amount: 10 }],
    prerequisites: ["energy_matrix"],
    summary: "利用高能光子裂解精炼油，重新分配氢与碳材料产出。",
    unlocks: ["X 射线裂解配方", "氢与石墨替代路线"],
  },
  reforming_refine: {
    id: "reforming_refine", name: "重整精炼", tier: 6,
    costs: [{ itemId: "electromagnetic_matrix", amount: 15 }, { itemId: "energy_matrix", amount: 15 }],
    prerequisites: ["xray_cracking", "basic_chemical_engineering"],
    summary: "消耗 2 份精炼油、1 份煤和 1 份氢，重整产出 3 份精炼油，每轮额外获得 1 份精炼油。",
    unlocks: ["重整精炼配方", "精炼油循环增产"],
  },
  high_strength_crystal: {
    id: "high_strength_crystal", name: "高强度晶体", tier: 5,
    costs: [{ itemId: "electromagnetic_matrix", amount: 10 }, { itemId: "energy_matrix", amount: 10 }],
    prerequisites: ["energy_matrix"],
    summary: "建立硅、钛与碳晶体的高温精炼流程，为结构材料提供基础。",
    unlocks: ["高纯硅块", "钛块", "金刚石", "石矿提炼硅石"],
  },
  basic_chemical_engineering: {
    id: "basic_chemical_engineering", name: "基础化工", tier: 5,
    costs: [{ itemId: "electromagnetic_matrix", amount: 10 }, { itemId: "energy_matrix", amount: 10 }],
    prerequisites: ["energy_matrix"],
    summary: "建立水资源输送与高分子反应设备，开始生产塑料。",
    unlocks: ["抽水站", "化工厂", "塑料配方"],
  },
  polymer_chemistry: {
    id: "polymer_chemistry", name: "高分子化工", tier: 6,
    costs: [{ itemId: "electromagnetic_matrix", amount: 15 }, { itemId: "energy_matrix", amount: 15 }],
    prerequisites: ["basic_chemical_engineering", "xray_cracking"],
    summary: "把塑料、精炼油与水重组为稳定的有机晶体。",
    unlocks: ["有机晶体配方"],
  },
  structure_matrix: {
    id: "structure_matrix", name: "结构矩阵", tier: 7,
    costs: [{ itemId: "electromagnetic_matrix", amount: 20 }, { itemId: "energy_matrix", amount: 20 }],
    prerequisites: ["high_strength_crystal", "polymer_chemistry"],
    summary: "以钛晶石和金刚石编码物质结构，建立第三阶段科研矩阵。",
    unlocks: ["钛晶石", "结构矩阵生产", "黄色矩阵科研"],
  },
  material_delivery_logistics: {
    id: "material_delivery_logistics", name: "物资直送物流", tier: 9,
    costs: [
      { itemId: "electromagnetic_matrix", amount: 30 },
      { itemId: "energy_matrix", amount: 30 },
      { itemId: "structure_matrix", amount: 30 },
    ],
    prerequisites: ["structure_matrix", "basic_logistics"],
    summary: "将三路传送带输入直接写入所在行星的物资托盘，减少重复搬运与仓储操作。",
    unlocks: ["物资配送枢纽", "3 个自动匹配输入接口", "物资托盘直送"],
  },
  proliferator_2: {
    id: "proliferator_2", name: "增产剂 Mk.II", tier: 8,
    costs: [{ itemId: "electromagnetic_matrix", amount: 25 }, { itemId: "energy_matrix", amount: 25 }, { itemId: "structure_matrix", amount: 20 }],
    prerequisites: ["structure_matrix", "high_strength_crystal", "proliferator_1"],
    summary: "利用金刚石稳定喷涂颗粒，在更高耗电下提升增产或加速收益。",
    unlocks: ["增产剂 Mk.II", "额外产出 +20%", "生产加速 +50%"],
  },
  titanium_alloy: {
    id: "titanium_alloy", name: "钛合金", tier: 8,
    costs: [{ itemId: "electromagnetic_matrix", amount: 20 }, { itemId: "energy_matrix", amount: 20 }, { itemId: "structure_matrix", amount: 10 }],
    prerequisites: ["structure_matrix"],
    summary: "利用硫酸改善钛与钢材的晶格结构，制造可承受星际航行环境的结构材料。",
    unlocks: ["硫酸合成", "钛合金配方", "熔岩星硫酸海洋开采"],
  },
  processor: {
    id: "processor", name: "处理器", tier: 8,
    costs: [{ itemId: "electromagnetic_matrix", amount: 20 }, { itemId: "energy_matrix", amount: 20 }, { itemId: "structure_matrix", amount: 10 }],
    prerequisites: ["structure_matrix"],
    summary: "以高纯硅制造微晶元件和处理器，为远程物流调度建立计算基础。",
    unlocks: ["微晶元件", "处理器配方"],
  },
  planetary_logistics: {
    id: "planetary_logistics", name: "行星物流系统", tier: 9,
    costs: [
      { itemId: "electromagnetic_matrix", amount: 10 },
      { itemId: "energy_matrix", amount: 10 },
      { itemId: "structure_matrix", amount: 10 },
    ],
    prerequisites: ["structure_matrix", "processor", "high_speed_logistics"],
    summary: "以物流运输机连接同一行星内的供需站，跨越画布完成无线物资调度。",
    unlocks: ["行星物流站", "物流运输机", "同星球无线运输"],
  },
  interstellar_logistics: {
    id: "interstellar_logistics", name: "星际物流系统", tier: 6,
    costs: [
      { itemId: "electromagnetic_matrix", amount: 20 },
      { itemId: "energy_matrix", amount: 20 },
    ],
    prerequisites: ["energy_matrix", "high_speed_logistics"],
    summary: "建立恒星系内导航与运输协议，开放母恒星系后两颗行星并解锁跨行星物流设施。",
    unlocks: ["烬原 II 与苍穹 III", "星际物流站", "物流运输船", "跨行星跳转与运输调度"],
  },
  nanomaterials: {
    id: "nanomaterials", name: "纳米材料", tier: 10,
    costs: [
      { itemId: "electromagnetic_matrix", amount: 20 },
      { itemId: "energy_matrix", amount: 20 },
      { itemId: "structure_matrix", amount: 20 },
    ],
    prerequisites: ["titanium_alloy", "processor"],
    summary: "把碳与硅材料推进到纳米尺度，为高密度信息载体建立材料基础。",
    unlocks: ["石墨烯", "碳纳米管", "晶格硅"],
  },
  rare_resource_utilization: {
    id: "rare_resource_utilization", name: "稀有资源利用", tier: 14,
    costs: [
      { itemId: "electromagnetic_matrix", amount: 35 },
      { itemId: "energy_matrix", amount: 35 },
      { itemId: "structure_matrix", amount: 35 },
      { itemId: "information_matrix", amount: 35 },
    ],
    prerequisites: ["quantum_chip", "interstellar_logistics", "nanomaterials"],
    summary: "识别稀有矿物的天然微观结构，以替代配方显著缩短六条高阶材料生产链。",
    unlocks: ["可燃冰裂解", "金伯利矿提炼", "分形硅晶格化", "光栅石光学配方", "刺笋结晶纳米管", "单极磁石粒子容器"],
  },
  quantum_chemical_engineering: {
    id: "quantum_chemical_engineering", name: "量子化工", tier: 16,
    costs: [
      { itemId: "electromagnetic_matrix", amount: 50 },
      { itemId: "energy_matrix", amount: 50 },
      { itemId: "structure_matrix", amount: 50 },
      { itemId: "information_matrix", amount: 50 },
      { itemId: "gravity_matrix", amount: 50 },
    ],
    prerequisites: ["gravity_matrix", "rare_resource_utilization"],
    summary: "以量子芯片控制高压反应腔，将全部化工配方速度提升到普通化工厂的两倍。",
    unlocks: ["量子化工厂", "化工厂原地升级", "化工速度 2.00×"],
  },
  orbital_collection: {
    id: "orbital_collection", name: "气态行星开采", tier: 11,
    costs: [
      { itemId: "electromagnetic_matrix", amount: 25 },
      { itemId: "energy_matrix", amount: 25 },
      { itemId: "structure_matrix", amount: 25 },
    ],
    prerequisites: ["interstellar_logistics", "nanomaterials"],
    summary: "将采集与星际供应整合到气态巨星轨道，持续获取氢和少量氘。",
    unlocks: ["轨道采集器", "苍岚 III 轨道部署", "氢与氘自动采集"],
  },
  information_matrix: {
    id: "information_matrix", name: "信息矩阵", tier: 11,
    costs: [
      { itemId: "electromagnetic_matrix", amount: 30 },
      { itemId: "energy_matrix", amount: 30 },
      { itemId: "structure_matrix", amount: 30 },
    ],
    prerequisites: ["interstellar_logistics", "nanomaterials"],
    summary: "将粒子宽带与处理器编码为高密度信息模型，建立第四阶段科研矩阵。",
    unlocks: ["粒子宽带", "信息矩阵生产", "紫色矩阵科研"],
  },
  construction_automation: {
    id: "construction_automation", name: "巨构建筑制造", tier: 13,
    costs: [
      { itemId: "electromagnetic_matrix", amount: 100 },
      { itemId: "energy_matrix", amount: 100 },
      { itemId: "structure_matrix", amount: 100 },
      { itemId: "information_matrix", amount: 100 },
    ],
    prerequisites: ["information_matrix", "high_speed_assembling"],
    summary: "建立巨构级建筑制造中心，按玩家设定的施工库存目标自动取料并持续补足。",
    unlocks: ["建筑制造中心", "目标库存 100", "5 秒自动制造周期"],
  },
  proliferator_3: {
    id: "proliferator_3", name: "增产剂 Mk.III", tier: 12,
    costs: [
      { itemId: "electromagnetic_matrix", amount: 30 },
      { itemId: "energy_matrix", amount: 30 },
      { itemId: "structure_matrix", amount: 30 },
      { itemId: "information_matrix", amount: 30 },
    ],
    prerequisites: ["information_matrix", "nanomaterials", "proliferator_2"],
    summary: "以碳纳米管维持高密度喷涂结构，获得最高增产与生产加速效果。",
    unlocks: ["增产剂 Mk.III", "额外产出 +25%", "生产加速 +100%"],
  },
  research_speed_1: {
    id: "research_speed_1", name: "科研速度 I", tier: 12,
    costs: [
      { itemId: "electromagnetic_matrix", amount: 20 },
      { itemId: "energy_matrix", amount: 20 },
      { itemId: "structure_matrix", amount: 20 },
      { itemId: "information_matrix", amount: 20 },
    ],
    prerequisites: ["information_matrix"],
    summary: "以四色矩阵优化科研站的演算管线，提高持续研究吞吐。",
    unlocks: ["矩阵研究速度 +25%"],
  },
  miniature_particle_collider: {
    id: "miniature_particle_collider", name: "微型粒子对撞机", tier: 13,
    costs: [
      { itemId: "electromagnetic_matrix", amount: 30 },
      { itemId: "energy_matrix", amount: 30 },
      { itemId: "structure_matrix", amount: 30 },
      { itemId: "information_matrix", amount: 30 },
    ],
    prerequisites: ["information_matrix"],
    summary: "以强磁场约束高能粒子，实现氘富集并为奇异物质生产建立设备基础。",
    unlocks: ["微型粒子对撞机", "超级磁场环", "氘", "氘核燃料棒", "粒子容器"],
  },
  fusion_power: {
    id: "fusion_power", name: "可控核聚变", tier: 14,
    costs: [
      { itemId: "electromagnetic_matrix", amount: 40 },
      { itemId: "energy_matrix", amount: 40 },
      { itemId: "structure_matrix", amount: 40 },
      { itemId: "information_matrix", amount: 40 },
    ],
    prerequisites: ["miniature_particle_collider", "energy_storage"],
    summary: "以氘核燃料棒维持稳定聚变反应，为中后期工业提供高密度可调度电力。",
    unlocks: ["微型聚变发电站", "15 MW 聚变电力"],
  },
  quantum_chip: {
    id: "quantum_chip", name: "量子芯片", tier: 13,
    costs: [
      { itemId: "electromagnetic_matrix", amount: 30 },
      { itemId: "energy_matrix", amount: 30 },
      { itemId: "structure_matrix", amount: 30 },
      { itemId: "information_matrix", amount: 30 },
    ],
    prerequisites: ["information_matrix", "nanomaterials"],
    summary: "利用卡西米尔晶体和位面过滤器构建高密度量子运算核心。",
    unlocks: ["钛化玻璃", "卡西米尔晶体", "位面过滤器", "量子芯片"],
  },
  plane_smelting: {
    id: "plane_smelting", name: "位面冶金", tier: 14,
    costs: [
      { itemId: "electromagnetic_matrix", amount: 30 },
      { itemId: "energy_matrix", amount: 30 },
      { itemId: "structure_matrix", amount: 30 },
      { itemId: "information_matrix", amount: 30 },
    ],
    prerequisites: ["miniature_particle_collider", "quantum_chip", "titanium_alloy"],
    summary: "利用强磁约束与位面过滤结构重构熔炼腔体，在相同节点规模下实现双倍冶金吞吐。",
    unlocks: ["位面熔炉", "熔炉原地升级", "熔炼速度 2.00×"],
  },
  gravity_matrix: {
    id: "gravity_matrix", name: "引力矩阵", tier: 14,
    costs: [
      { itemId: "electromagnetic_matrix", amount: 40 },
      { itemId: "energy_matrix", amount: 40 },
      { itemId: "structure_matrix", amount: 40 },
      { itemId: "information_matrix", amount: 40 },
    ],
    prerequisites: ["miniature_particle_collider", "quantum_chip"],
    summary: "将奇异物质、引力透镜与量子芯片组合为第五阶段科研矩阵。",
    unlocks: ["奇异物质", "引力透镜", "引力矩阵生产", "绿色矩阵科研"],
  },
  construction_capacity_1: {
    id: "construction_capacity_1", name: "建筑仓储扩容 I", tier: 16,
    costs: [
      { itemId: "electromagnetic_matrix", amount: 150 },
      { itemId: "energy_matrix", amount: 150 },
      { itemId: "structure_matrix", amount: 150 },
      { itemId: "information_matrix", amount: 150 },
      { itemId: "gravity_matrix", amount: 150 },
    ],
    prerequisites: ["construction_automation", "gravity_matrix"],
    summary: "以引力矩阵压缩施工仓储与调度队列，提高自动补货上限和制造速度。",
    unlocks: ["目标库存上限 500", "自动制造周期 2.5 秒"],
  },
  space_warp: {
    id: "space_warp", name: "空间翘曲", tier: 15,
    costs: [
      { itemId: "electromagnetic_matrix", amount: 30 },
      { itemId: "energy_matrix", amount: 30 },
      { itemId: "structure_matrix", amount: 30 },
      { itemId: "information_matrix", amount: 30 },
      { itemId: "gravity_matrix", amount: 30 },
    ],
    prerequisites: ["gravity_matrix", "interstellar_logistics"],
    summary: "以引力透镜折叠航线距离，为跨恒星物流运输船提供曲率航行能力。",
    unlocks: ["空间翘曲器", "星际站翘曲器仓", "跨恒星航线准备"],
  },
  stellar_exploration: {
    id: "stellar_exploration", name: "恒星探索", tier: 16,
    costs: [
      { itemId: "electromagnetic_matrix", amount: 40 },
      { itemId: "energy_matrix", amount: 40 },
      { itemId: "structure_matrix", amount: 40 },
      { itemId: "information_matrix", amount: 40 },
      { itemId: "gravity_matrix", amount: 40 },
    ],
    prerequisites: ["space_warp", "rare_resource_utilization"],
    summary: "校准恒星级导航阵列，消耗勘探补给发现远方恒星系并建立永久航标。",
    unlocks: ["星图", "北冕座勘探", "赫卡忒中子星系勘探"],
  },
  quantum_printing: {
    id: "quantum_printing", name: "量子打印技术", tier: 15,
    costs: [
      { itemId: "electromagnetic_matrix", amount: 30 },
      { itemId: "energy_matrix", amount: 30 },
      { itemId: "structure_matrix", amount: 30 },
      { itemId: "information_matrix", amount: 30 },
      { itemId: "gravity_matrix", amount: 30 },
    ],
    prerequisites: ["gravity_matrix", "high_speed_assembling"],
    summary: "用量子芯片和粒子宽带控制精密装配过程，进一步压缩高阶物品生产周期。",
    unlocks: ["制造台 Mk.III", "装配速度 1.50×"],
  },
  super_magnetic_logistics: {
    id: "super_magnetic_logistics", name: "超级磁场物流", tier: 15,
    costs: [
      { itemId: "electromagnetic_matrix", amount: 30 },
      { itemId: "energy_matrix", amount: 30 },
      { itemId: "structure_matrix", amount: 30 },
      { itemId: "information_matrix", amount: 30 },
      { itemId: "gravity_matrix", amount: 30 },
    ],
    prerequisites: ["gravity_matrix", "high_speed_logistics"],
    summary: "以超级磁场环稳定高速运输线路，使单线路吞吐提升至基础传送带的五倍。",
    unlocks: ["传送带 Mk.III", "单线物流 30/s"],
  },
  research_speed_2: {
    id: "research_speed_2", name: "科研速度 II", tier: 15,
    costs: [
      { itemId: "electromagnetic_matrix", amount: 20 },
      { itemId: "energy_matrix", amount: 20 },
      { itemId: "structure_matrix", amount: 20 },
      { itemId: "information_matrix", amount: 20 },
      { itemId: "gravity_matrix", amount: 20 },
    ],
    prerequisites: ["gravity_matrix", "research_speed_1"],
    summary: "以五色矩阵继续优化科研站演算管线，使研究吞吐累计提升 50%。",
    unlocks: ["矩阵研究速度累计 +50%"],
  },
  dyson_swarm: {
    id: "dyson_swarm", name: "戴森云", tier: 16,
    costs: [
      { itemId: "electromagnetic_matrix", amount: 50 },
      { itemId: "energy_matrix", amount: 50 },
      { itemId: "structure_matrix", amount: 50 },
      { itemId: "information_matrix", amount: 50 },
      { itemId: "gravity_matrix", amount: 50 },
    ],
    prerequisites: ["gravity_matrix"],
    summary: "以电磁轨道弹射器将太阳帆持续送入恒星轨道，建立可扩张但会衰减的戴森云。",
    unlocks: ["光子合并器", "太阳帆", "电磁轨道弹射器", "戴森云发电"],
  },
  ray_receiver: {
    id: "ray_receiver", name: "射线接收站", tier: 17,
    costs: [
      { itemId: "electromagnetic_matrix", amount: 60 },
      { itemId: "energy_matrix", amount: 60 },
      { itemId: "structure_matrix", amount: 60 },
      { itemId: "information_matrix", amount: 60 },
      { itemId: "gravity_matrix", amount: 60 },
    ],
    prerequisites: ["dyson_swarm"],
    summary: "跨行星共享戴森云输出，并在直接发电和临界光子生成之间分配恒星能。",
    unlocks: ["射线接收站", "电力接收模式", "临界光子模式"],
  },
  antimatter: {
    id: "antimatter", name: "质能储存", tier: 18,
    costs: [
      { itemId: "electromagnetic_matrix", amount: 80 },
      { itemId: "energy_matrix", amount: 80 },
      { itemId: "structure_matrix", amount: 80 },
      { itemId: "information_matrix", amount: 80 },
      { itemId: "gravity_matrix", amount: 80 },
    ],
    prerequisites: ["ray_receiver"],
    summary: "在粒子对撞机中拆分临界光子，并将反物质封装为高密度可调度燃料。",
    unlocks: ["质能转换", "湮灭约束球", "反物质燃料棒"],
  },
  artificial_star: {
    id: "artificial_star", name: "人造恒星", tier: 19,
    costs: [
      { itemId: "electromagnetic_matrix", amount: 100 },
      { itemId: "energy_matrix", amount: 100 },
      { itemId: "structure_matrix", amount: 100 },
      { itemId: "information_matrix", amount: 100 },
      { itemId: "gravity_matrix", amount: 100 },
    ],
    prerequisites: ["antimatter", "fusion_power"],
    summary: "在强约束场中持续湮灭反物质燃料，将终局燃料链转化为超高功率电源。",
    unlocks: ["人造恒星", "72 MW 反物质电力"],
  },
  universe_matrix: {
    id: "universe_matrix", name: "宇宙矩阵", tier: 19,
    costs: [
      { itemId: "electromagnetic_matrix", amount: 100 },
      { itemId: "energy_matrix", amount: 100 },
      { itemId: "structure_matrix", amount: 100 },
      { itemId: "information_matrix", amount: 100 },
      { itemId: "gravity_matrix", amount: 100 },
    ],
    prerequisites: ["antimatter"],
    summary: "把五色矩阵的研究数据与反物质统一编码，形成最终阶段的白色科研矩阵。",
    unlocks: ["宇宙矩阵生产", "六色矩阵科研"],
  },
  micro_black_hole_containment: {
    id: "micro_black_hole_containment", name: "微型黑洞约束工程", tier: 20,
    costs: [
      { itemId: "electromagnetic_matrix", amount: 500 },
      { itemId: "energy_matrix", amount: 500 },
      { itemId: "structure_matrix", amount: 500 },
      { itemId: "information_matrix", amount: 500 },
      { itemId: "gravity_matrix", amount: 500 },
      { itemId: "universe_matrix", amount: 500 },
    ],
    prerequisites: ["universe_matrix"],
    summary: "建立可控微型事件视界，以三个独立接口永久处理任意传送带物资。",
    unlocks: ["微型黑洞连接装置"],
  },
  time_warp_engineering: {
    id: "time_warp_engineering", name: "时间扭曲工程", tier: 20,
    costs: [
      { itemId: "electromagnetic_matrix", amount: 1000 },
      { itemId: "energy_matrix", amount: 1000 },
      { itemId: "structure_matrix", amount: 1000 },
      { itemId: "information_matrix", amount: 1000 },
      { itemId: "gravity_matrix", amount: 1000 },
      { itemId: "universe_matrix", amount: 1000 },
    ],
    prerequisites: ["universe_matrix", "artificial_star"],
    summary: "以指数级电力维持全局时间加速，同时保持离线收益和活动时钟使用真实时间。",
    unlocks: ["时间扭曲装置", "5x 及更高实时模拟倍率"],
  },
  construction_capacity_2: {
    id: "construction_capacity_2", name: "建筑仓储扩容 II", tier: 20,
    costs: [
      { itemId: "electromagnetic_matrix", amount: 300 },
      { itemId: "energy_matrix", amount: 300 },
      { itemId: "structure_matrix", amount: 300 },
      { itemId: "information_matrix", amount: 300 },
      { itemId: "gravity_matrix", amount: 300 },
      { itemId: "universe_matrix", amount: 300 },
    ],
    prerequisites: ["construction_capacity_1", "universe_matrix"],
    summary: "使用宇宙矩阵统一建筑制造协议，将库存与制造吞吐提升到终局规模。",
    unlocks: ["目标库存上限 10万", "自动制造周期 1 秒"],
  },
  research_speed_3: {
    id: "research_speed_3", name: "科研速度 III", tier: 20,
    costs: [
      { itemId: "electromagnetic_matrix", amount: 30 },
      { itemId: "energy_matrix", amount: 30 },
      { itemId: "structure_matrix", amount: 30 },
      { itemId: "information_matrix", amount: 30 },
      { itemId: "gravity_matrix", amount: 30 },
      { itemId: "universe_matrix", amount: 30 },
    ],
    prerequisites: ["universe_matrix", "research_speed_2"],
    summary: "以六色矩阵统一科研站演算管线，使研究吞吐累计提升至 75%。",
    unlocks: ["矩阵研究速度累计 +75%"],
  },
  dyson_sphere_program: {
    id: "dyson_sphere_program", name: "戴森球计划", tier: 21,
    costs: [
      { itemId: "electromagnetic_matrix", amount: 100 },
      { itemId: "energy_matrix", amount: 100 },
      { itemId: "structure_matrix", amount: 100 },
      { itemId: "information_matrix", amount: 100 },
      { itemId: "gravity_matrix", amount: 100 },
      { itemId: "universe_matrix", amount: 100 },
    ],
    prerequisites: ["universe_matrix"],
    summary: "以框架材料和戴森球组件建立可永久存在的恒星级能源结构。",
    unlocks: ["框架材料", "戴森球组件", "戴森球结构规划"],
  },
  vertical_launching_silo: {
    id: "vertical_launching_silo", name: "垂直发射井", tier: 22,
    costs: [
      { itemId: "electromagnetic_matrix", amount: 120 },
      { itemId: "energy_matrix", amount: 120 },
      { itemId: "structure_matrix", amount: 120 },
      { itemId: "information_matrix", amount: 120 },
      { itemId: "gravity_matrix", amount: 120 },
      { itemId: "universe_matrix", amount: 120 },
    ],
    prerequisites: ["dyson_sphere_program"],
    summary: "制造小型运载火箭并通过高功率垂直发射井建设戴森球结构节点。",
    unlocks: ["小型运载火箭", "垂直发射井", "永久结构点"],
  },
  dyson_shell: {
    id: "dyson_shell", name: "戴森壳面", tier: 23,
    costs: [
      { itemId: "electromagnetic_matrix", amount: 150 },
      { itemId: "energy_matrix", amount: 150 },
      { itemId: "structure_matrix", amount: 150 },
      { itemId: "information_matrix", amount: 150 },
      { itemId: "gravity_matrix", amount: 150 },
      { itemId: "universe_matrix", amount: 200 },
    ],
    prerequisites: ["vertical_launching_silo"],
    summary: "让戴森球结构自动吸附轨道太阳帆，将临时戴森云转化为永久发电壳面。",
    unlocks: ["太阳帆自动吸附", "永久壳面发电", "结构容量扩张"],
  },
  mining_speed_2: {
    id: "mining_speed_2", name: "高效采矿 II", tier: 10,
    costs: [
      { itemId: "electromagnetic_matrix", amount: 25 },
      { itemId: "energy_matrix", amount: 25 },
      { itemId: "structure_matrix", amount: 25 },
    ],
    prerequisites: ["structure_matrix", "mining_speed_1"],
    summary: "以结构矩阵重算矿脉覆盖与设备间距，使固体采矿吞吐累计提升至基础速度的两倍。",
    unlocks: ["固体矿物开采速度累计 2.00×"],
  },
  mining_speed_3: {
    id: "mining_speed_3", name: "高效采矿 III", tier: 15,
    costs: [
      { itemId: "electromagnetic_matrix", amount: 40 },
      { itemId: "energy_matrix", amount: 40 },
      { itemId: "structure_matrix", amount: 40 },
      { itemId: "information_matrix", amount: 40 },
      { itemId: "gravity_matrix", amount: 40 },
    ],
    prerequisites: ["gravity_matrix", "mining_speed_2"],
    summary: "利用引力场稳定高密度开采阵列，使固体矿物吞吐达到基础速度的三倍。",
    unlocks: ["固体矿物开采速度累计 3.00×"],
  },
  logistics_engine_1: {
    id: "logistics_engine_1", name: "物流运输引擎 I", tier: 10,
    costs: [
      { itemId: "electromagnetic_matrix", amount: 25 },
      { itemId: "energy_matrix", amount: 25 },
      { itemId: "structure_matrix", amount: 25 },
    ],
    prerequisites: ["interstellar_logistics"],
    summary: "升级运输机和运输船推进系统，将全部常规物流航程速度提升 50%。",
    unlocks: ["物流航行速度 1.50×", "行星航程 5.3 秒", "星际航程 20 秒"],
  },
  logistics_engine_2: {
    id: "logistics_engine_2", name: "物流运输引擎 II", tier: 16,
    costs: [
      { itemId: "electromagnetic_matrix", amount: 45 },
      { itemId: "energy_matrix", amount: 45 },
      { itemId: "structure_matrix", amount: 45 },
      { itemId: "information_matrix", amount: 45 },
      { itemId: "gravity_matrix", amount: 45 },
    ],
    prerequisites: ["space_warp", "logistics_engine_1"],
    summary: "把引力透镜导航并入物流推进器，使全部物流航程速度累计提升至两倍。",
    unlocks: ["物流航行速度累计 2.00×", "行星航程 4 秒", "翘曲航程 6 秒"],
  },
  logistics_capacity_1: {
    id: "logistics_capacity_1", name: "物流载荷扩容 I", tier: 11,
    costs: [
      { itemId: "electromagnetic_matrix", amount: 30 },
      { itemId: "energy_matrix", amount: 30 },
      { itemId: "structure_matrix", amount: 30 },
      { itemId: "information_matrix", amount: 30 },
    ],
    prerequisites: ["information_matrix", "interstellar_logistics"],
    summary: "优化货舱结构与装载算法，使每架运输机和每艘运输船的单次载荷提高 50%。",
    unlocks: ["运输机载荷 38", "运输船载荷 150"],
  },
  logistics_capacity_2: {
    id: "logistics_capacity_2", name: "物流载荷扩容 II", tier: 16,
    costs: [
      { itemId: "electromagnetic_matrix", amount: 45 },
      { itemId: "energy_matrix", amount: 45 },
      { itemId: "structure_matrix", amount: 45 },
      { itemId: "information_matrix", amount: 45 },
      { itemId: "gravity_matrix", amount: 45 },
    ],
    prerequisites: ["gravity_matrix", "logistics_capacity_1"],
    summary: "以引力约束稳定满载货舱，使物流载荷累计提升至基础容量的两倍。",
    unlocks: ["运输机载荷 50", "运输船载荷 200"],
  },
  solar_sail_life_1: {
    id: "solar_sail_life_1", name: "太阳帆轨道寿命 I", tier: 17,
    costs: [
      { itemId: "electromagnetic_matrix", amount: 50 },
      { itemId: "energy_matrix", amount: 50 },
      { itemId: "structure_matrix", amount: 50 },
      { itemId: "information_matrix", amount: 50 },
      { itemId: "gravity_matrix", amount: 50 },
    ],
    prerequisites: ["dyson_swarm"],
    summary: "改进太阳帆姿态控制和光压补偿，将单帆在轨寿命从 20 分钟延长到 30 分钟。",
    unlocks: ["太阳帆在轨寿命 30 分钟"],
  },
  solar_sail_life_2: {
    id: "solar_sail_life_2", name: "太阳帆轨道寿命 II", tier: 20,
    costs: [
      { itemId: "electromagnetic_matrix", amount: 70 },
      { itemId: "energy_matrix", amount: 70 },
      { itemId: "structure_matrix", amount: 70 },
      { itemId: "information_matrix", amount: 70 },
      { itemId: "gravity_matrix", amount: 70 },
      { itemId: "universe_matrix", amount: 70 },
    ],
    prerequisites: ["universe_matrix", "solar_sail_life_1"],
    summary: "以宇宙矩阵预测轨道摄动，将太阳帆在轨寿命累计延长到 40 分钟。",
    unlocks: ["太阳帆在轨寿命累计 40 分钟"],
  },
  ray_transmission_1: {
    id: "ray_transmission_1", name: "射线传输效率 I", tier: 18,
    costs: [
      { itemId: "electromagnetic_matrix", amount: 60 },
      { itemId: "energy_matrix", amount: 60 },
      { itemId: "structure_matrix", amount: 60 },
      { itemId: "information_matrix", amount: 60 },
      { itemId: "gravity_matrix", amount: 60 },
    ],
    prerequisites: ["ray_receiver", "solar_sail_life_1"],
    summary: "校准恒星射线相位与接收阵列，使每台射线接收站额定功率提升至 9 MW。",
    unlocks: ["射线接收上限 9 MW/台"],
  },
  ray_transmission_2: {
    id: "ray_transmission_2", name: "射线传输效率 II", tier: 20,
    costs: [
      { itemId: "electromagnetic_matrix", amount: 80 },
      { itemId: "energy_matrix", amount: 80 },
      { itemId: "structure_matrix", amount: 80 },
      { itemId: "information_matrix", amount: 80 },
      { itemId: "gravity_matrix", amount: 80 },
      { itemId: "universe_matrix", amount: 80 },
    ],
    prerequisites: ["universe_matrix", "ray_transmission_1"],
    summary: "用宇宙矩阵统一发射与接收模型，使每台接收站额定功率累计提升至 12 MW。",
    unlocks: ["射线接收上限累计 12 MW/台"],
  },
  dyson_absorption_1: {
    id: "dyson_absorption_1", name: "壳面吸附效率", tier: 24,
    costs: [
      { itemId: "electromagnetic_matrix", amount: 150 },
      { itemId: "energy_matrix", amount: 150 },
      { itemId: "structure_matrix", amount: 150 },
      { itemId: "information_matrix", amount: 150 },
      { itemId: "gravity_matrix", amount: 150 },
      { itemId: "universe_matrix", amount: 200 },
    ],
    prerequisites: ["dyson_shell", "ray_transmission_2"],
    summary: "同步壳面框架与太阳帆姿态控制，使永久结构吸附轨道太阳帆的速度提高一倍。",
    unlocks: ["壳面太阳帆吸附速度 2.00×"],
  },
  orbital_elevator_engineering: {
    id: "orbital_elevator_engineering", name: "轨道升降工程", tier: 24,
    costs: [{ itemId: "universe_matrix", amount: 100_000 }],
    prerequisites: ["universe_matrix", "interstellar_logistics"],
    summary: "以轨道升降结构改造星际物流站，使其可以原地升级为保留传统功能的 Mk.II。",
    unlocks: ["星际物流站 Mk.II", "太空电梯模式切换"],
  },
  orbital_multi_cargo_bus: {
    id: "orbital_multi_cargo_bus", name: "多物质轨道汇流", tier: 25,
    costs: [{ itemId: "universe_matrix", amount: 1_000_000 }],
    prerequisites: ["orbital_elevator_engineering", "universe_matrix"],
    summary: "把五个传统输入汇合为一个通用入口，并为太空电梯开放五路独立输出。",
    unlocks: ["通用输入口", "五路电梯输出口", "恒星系共享仓库"],
  },
  orbital_energy_recovery: {
    id: "orbital_energy_recovery", name: "轨道升降能量回收", tier: 26,
    costs: [{ itemId: "universe_matrix", amount: 10_000_000 }],
    prerequisites: ["orbital_multi_cargo_bus", "dyson_shell"],
    summary: "回收电梯升降过程中的能量，使太空电梯动态物流能耗降低 50%。",
    unlocks: ["太空电梯能耗 -50%", "联合协议前置"],
  },
  system_space_station_engineering: {
    id: "system_space_station_engineering", name: "恒星系空间站工程", tier: 24,
    costs: [{ itemId: "universe_matrix", amount: 1_000_000 }],
    prerequisites: ["universe_matrix", "dyson_sphere_program", "vertical_launching_silo"],
    summary: "解锁每个已探索恒星系独立建设一座联合空间站的施工工地。",
    unlocks: ["空间站建设工地", "空间站施工发射平台"],
  },
  orbital_modular_assembly: {
    id: "orbital_modular_assembly", name: "轨道模块化装配", tier: 25,
    costs: [{ itemId: "universe_matrix", amount: 10_000_000 }],
    prerequisites: ["system_space_station_engineering", "orbital_multi_cargo_bus"],
    summary: "把空间站施工材料需求降至 90%，并让施工平台吞吐翻倍。",
    unlocks: ["空间站 90% 成本", "物流主干模块"],
  },
  autonomous_station_construction: {
    id: "autonomous_station_construction", name: "自律空间站建造", tier: 26,
    costs: [{ itemId: "universe_matrix", amount: 100_000_000 }],
    prerequisites: ["orbital_modular_assembly", "orbital_energy_recovery"],
    summary: "以自律施工机器人把新空间站材料需求降至 80%，并开放能源与星际运输模块。",
    unlocks: ["空间站 80% 成本", "能源核心模块", "星际运输模块"],
  },
  unified_system_logistics_protocol: {
    id: "unified_system_logistics_protocol", name: "恒星系联合物流协议", tier: 27,
    costs: [{ itemId: "universe_matrix", amount: 1_000_000_000 }],
    prerequisites: ["orbital_energy_recovery", "autonomous_station_construction"],
    summary: "将已建空间站接入共享舰队、共享翘曲仓和银河能源池，开启跨恒星系聚合调度。",
    unlocks: ["最多 8 座空间站聚合物流", "共享舰队与翘曲仓", "银河能源池"],
  },
  quantum_logistics_network: {
    id: "quantum_logistics_network", name: "量子物流网络", tier: 24,
    costs: [
      { itemId: "electromagnetic_matrix", amount: 500 },
      { itemId: "energy_matrix", amount: 500 },
      { itemId: "structure_matrix", amount: 500 },
      { itemId: "information_matrix", amount: 500 },
      { itemId: "gravity_matrix", amount: 500 },
      { itemId: "universe_matrix", amount: 1_000 },
    ],
    prerequisites: ["interstellar_logistics", "space_warp", "universe_matrix"],
    summary: "把已升级的星际物流塔接入一份全宇宙共享物资池；供应物资送达时优先直接入池，下载与溢出缓存仍在五秒边界结算。",
    unlocks: ["量子物流塔接入", "全宇宙共享库存", "量子网络全局吞吐"],
  },
};

/**
 * Historical system-space-station technologies remain in the catalog so old
 * saves and migration code can resolve their ids, but they are no longer
 * offered as new research.  The orbital elevator chain still unlocks the
 * compatible Mk.II station upgrade used by existing saves.
 */
export const DEPRECATED_TECHNOLOGY_IDS: ReadonlySet<TechId> = new Set<TechId>([
  "orbital_elevator_engineering",
  "orbital_multi_cargo_bus",
  "orbital_energy_recovery",
  "system_space_station_engineering",
  "orbital_modular_assembly",
  "autonomous_station_construction",
  "unified_system_logistics_protocol",
]);

export function isDeprecatedTechnology(id: TechId | null | undefined): boolean {
  return Boolean(id && DEPRECATED_TECHNOLOGY_IDS.has(id));
}

export const TECHNOLOGY_LIST = Object.values(TECHNOLOGIES).filter((technology) => !isDeprecatedTechnology(technology.id));

export const FUEL_ENERGY_MJ: Partial<Record<ItemId, number>> = {
  coal: 2.7,
  fire_ice: 4.8,
  crude_oil: 4,
  energetic_graphite: 6.3,
  refined_oil: 4.4,
  hydrogen: 8,
  hydrogen_fuel_rod: 54,
  deuteron_fuel_rod: 600,
  antimatter_fuel_rod: 7200,
};

export const FUEL_ITEM_IDS = Object.keys(FUEL_ENERGY_MJ) as ItemId[];

const FUSION_FUEL_ITEM_IDS: ItemId[] = ["deuteron_fuel_rod"];
const ARTIFICIAL_STAR_FUEL_ITEM_IDS: ItemId[] = ["antimatter_fuel_rod"];

export function getFuelItemIdsForBuilding(buildingId: BuildingId): ItemId[] {
  if (buildingId === "mini_fusion_power_plant") return FUSION_FUEL_ITEM_IDS;
  if (buildingId === "artificial_star") return ARTIFICIAL_STAR_FUEL_ITEM_IDS;
  return buildingId === "thermal_power_plant" ? FUEL_ITEM_IDS : [];
}

export function getFuelEfficiency(buildingId: BuildingId): number {
  return buildingId === "thermal_power_plant" ? 0.8 : 1;
}

export function getPlanet(id: PlanetId): PlanetDefinition {
  return PLANETS[id];
}

export function getStarSystem(id: StarSystemId): StarSystemDefinition {
  return STAR_SYSTEMS[id];
}

export function getPlanetsForSystem(id: StarSystemId): PlanetDefinition[] {
  return STAR_SYSTEMS[id].planetIds.map((planetId) => PLANETS[planetId]);
}

export function getExtractorBuildingId(resourceId: ItemId): BuildingId {
  if (resourceId === "crude_oil") return "oil_extractor";
  if (resourceId === "water" || resourceId === "sulfuric_acid") return "water_pump";
  return "mining_machine";
}

export function getItem(id: ItemId): ItemDefinition {
  return ITEMS[id];
}

export function getBuilding(id: BuildingId): BuildingDefinition {
  return BUILDINGS[id];
}

export function getConstructionDefinition(id: ConstructionId): ConstructionDefinition | undefined {
  return CONSTRUCTION.find((definition) => definition.buildingId === id);
}

export function getCompatibleRecipeBuildings(recipe: RecipeDefinition): BuildingDefinition[] {
  return Object.values(BUILDINGS).filter((building) => buildingSupportsRecipe(building.id, recipe));
}

export function getRecipe(id: RecipeId | undefined): RecipeDefinition | undefined {
  return id ? RECIPES[id] : undefined;
}

export function getTechnology(id: TechId | null | undefined): TechnologyDefinition | undefined {
  return id ? TECHNOLOGIES[id] : undefined;
}

export interface ContentAuditIssue {
  severity: "error" | "warning";
  code: string;
  id: string;
  message: string;
}

export interface ContentAuditResult {
  valid: boolean;
  issues: ContentAuditIssue[];
}

/**
 * Validate the data registry at runtime so additions to the catalog cannot
 * silently create broken recipe cards, unreachable technologies, or save data
 * that points at an unknown content id.
 */
export function validateContentCatalog(): ContentAuditResult {
  const issues: ContentAuditIssue[] = [];
  const itemIds = new Set(Object.keys(ITEMS));
  const buildingIds = new Set(Object.keys(BUILDINGS));
  const techIds = new Set(Object.keys(TECHNOLOGIES));
  const add = (severity: ContentAuditIssue["severity"], code: string, id: string, message: string) => issues.push({ severity, code, id, message });

  for (const recipe of Object.values(RECIPES)) {
    if (!buildingIds.has(recipe.buildingId)) add("error", "recipe-building", recipe.id, `配方引用未知设备 ${recipe.buildingId}`);
    if (recipe.duration <= 0 || !Number.isFinite(recipe.duration)) add("error", "recipe-duration", recipe.id, "配方周期必须为正数");
    if (recipe.requiredTechId && !techIds.has(recipe.requiredTechId)) add("error", "recipe-tech", recipe.id, `配方引用未知科技 ${recipe.requiredTechId}`);
    for (const entry of [...recipe.inputs, ...recipe.outputs]) {
      if (!itemIds.has(entry.itemId)) add("error", "recipe-item", recipe.id, `配方引用未知物品 ${entry.itemId}`);
      if (entry.amount <= 0 || !Number.isFinite(entry.amount)) add("error", "recipe-amount", recipe.id, "配方数量必须为正数");
    }
    if (recipe.outputs.length === 0 && !["solar_sail_launch", "carrier_rocket_launch", "ray_power"].includes(recipe.id)) {
      add("warning", "recipe-no-output", recipe.id, "配方没有实体产物，将只作为流程记录");
    }
  }

  for (const definition of CONSTRUCTION) {
    if (!isConveyorBeltId(definition.buildingId) && !definition.buildingId.startsWith("sorter_") && !buildingIds.has(definition.buildingId)) {
      add("error", "construction-building", definition.buildingId, "施工定义引用未知建筑");
    }
    if (definition.requiredTechId && !techIds.has(definition.requiredTechId)) add("error", "construction-tech", definition.buildingId, `施工定义引用未知科技 ${definition.requiredTechId}`);
    for (const cost of definition.costs) if (!itemIds.has(cost.itemId)) add("error", "construction-item", definition.buildingId, `施工成本引用未知物品 ${cost.itemId}`);
  }

  for (const technology of Object.values(TECHNOLOGIES)) {
    for (const prerequisite of technology.prerequisites) if (!techIds.has(prerequisite)) add("error", "tech-prerequisite", technology.id, `科技引用未知前置 ${prerequisite}`);
    for (const cost of technology.costs) if (!itemIds.has(cost.itemId)) add("error", "tech-item", technology.id, `科技成本引用未知物品 ${cost.itemId}`);
  }

  const visiting = new Set<TechId>();
  const visited = new Set<TechId>();
  const walk = (techId: TechId) => {
    if (visiting.has(techId)) {
      add("error", "tech-cycle", techId, "科技前置关系存在循环");
      return;
    }
    if (visited.has(techId)) return;
    visiting.add(techId);
    for (const prerequisite of TECHNOLOGIES[techId]?.prerequisites ?? []) if (TECHNOLOGIES[prerequisite]) walk(prerequisite);
    visiting.delete(techId);
    visited.add(techId);
  };
  for (const technology of Object.values(TECHNOLOGIES)) walk(technology.id);

  return { valid: issues.every((issue) => issue.severity !== "error"), issues };
}
