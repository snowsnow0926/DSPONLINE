import { readFileSync, readdirSync } from "node:fs";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";

const NATIVE_PLAYER_SURFACE = /^Native(?:.+(?:Workspace|Panel|Rail|Dock)|StarMapWorkspace|DysonPlannerWorkspace)$/;
const FORBIDDEN_PROP_NAMES = new Set([
  "game",
  "gamestate",
  "state",
  "worker",
  "simulationworker",
  "commitgame",
  "ongamechange",
  "setgame",
  "publishruntimegame",
]);
const FORBIDDEN_EXPRESSION_IDENTIFIERS = new Set([
  "game",
  "gameRef",
  "panelGame",
  "simulationWorker",
  "simulationWorkerRef",
  "worker",
  "workerRef",
  "commitGame",
  "setGame",
  "publishRuntimeGame",
]);
const FORBIDDEN_NATIVE_COMPONENT_TYPES = new Set([
  "GameState",
  "FactoryEntity",
  "BeltConnection",
]);

function lineAndColumn(sourceFile, node) {
  const point = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  return `${sourceFile.fileName}:${point.line + 1}:${point.character + 1}`;
}

function collectExpressionIdentifiers(node, identifiers) {
  if (ts.isIdentifier(node) &&
      !(ts.isPropertyAccessExpression(node.parent) && node.parent.name === node) &&
      !(ts.isPropertyAssignment(node.parent) && node.parent.name === node)) {
    identifiers.add(node.text);
  }
  ts.forEachChild(node, (child) => collectExpressionIdentifiers(child, identifiers));
}

export function inspectNativeSurfaceBindings(source, fileName = "src/App.tsx") {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const failures = [];
  let surfaceCount = 0;

  const visit = (node) => {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const tagName = node.tagName.getText(sourceFile);
      if (NATIVE_PLAYER_SURFACE.test(tagName)) {
        surfaceCount += 1;
        for (const attribute of node.attributes.properties) {
          if (ts.isJsxSpreadAttribute(attribute)) {
            failures.push(`${lineAndColumn(sourceFile, attribute)} ${tagName} must not hide authority data behind a JSX spread`);
            continue;
          }
          const propName = attribute.name.getText(sourceFile);
          if (FORBIDDEN_PROP_NAMES.has(propName.toLocaleLowerCase("en-US"))) {
            failures.push(`${lineAndColumn(sourceFile, attribute)} ${tagName}.${propName} crosses the full-state/legacy-writer boundary`);
          }
          const expression = attribute.initializer && ts.isJsxExpression(attribute.initializer)
            ? attribute.initializer.expression
            : null;
          if (!expression) continue;
          const identifiers = new Set();
          collectExpressionIdentifiers(expression, identifiers);
          const forbidden = [...identifiers].filter((identifier) => FORBIDDEN_EXPRESSION_IDENTIFIERS.has(identifier));
          if (forbidden.length > 0) {
            failures.push(`${lineAndColumn(sourceFile, attribute)} ${tagName}.${propName} directly captures ${forbidden.join(", ")}`);
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return { failures, surfaceCount };
}

export function inspectNativeComponentSource(source, fileName) {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const failures = [];
  const visit = (node) => {
    if (ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName) &&
        FORBIDDEN_NATIVE_COMPONENT_TYPES.has(node.typeName.text)) {
      failures.push(`${lineAndColumn(sourceFile, node)} native component references forbidden full factory type ${node.typeName.text}`);
    }
    if (ts.isIdentifier(node) &&
        !(ts.isPropertyAccessExpression(node.parent) && node.parent.name === node) &&
        FORBIDDEN_EXPRESSION_IDENTIFIERS.has(node.text) &&
        (ts.isCallExpression(node.parent) || ts.isPropertyAccessExpression(node.parent))) {
      failures.push(`${lineAndColumn(sourceFile, node)} native component directly uses legacy authority identifier ${node.text}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return failures;
}

export function verifyNativeThinUiBoundary(rootDirectory = process.cwd()) {
  const appPath = resolve(rootDirectory, "src", "App.tsx");
  const appResult = inspectNativeSurfaceBindings(readFileSync(appPath, "utf8"), appPath);
  const failures = [...appResult.failures];
  if (appResult.surfaceCount < 10) {
    failures.push(`${appPath} exposes only ${appResult.surfaceCount} dedicated native player surfaces; expected at least 10`);
  }

  const componentsDirectory = resolve(rootDirectory, "src", "components");
  const componentFiles = readdirSync(componentsDirectory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /^Native.+\.tsx$/.test(entry.name) && !entry.name.endsWith(".test.tsx"))
    .map((entry) => resolve(componentsDirectory, entry.name));
  for (const componentPath of componentFiles) {
    failures.push(...inspectNativeComponentSource(readFileSync(componentPath, "utf8"), componentPath));
  }
  return {
    failures,
    nativeComponentFiles: componentFiles.length,
    nativeSurfaceBindings: appResult.surfaceCount,
  };
}

function isDirectInvocation() {
  return process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
}

if (isDirectInvocation()) {
  const report = verifyNativeThinUiBoundary();
  if (report.failures.length > 0) {
    console.error(`Native thin-UI boundary failed with ${report.failures.length} violation(s):`);
    for (const failure of report.failures) console.error(`- ${failure}`);
    process.exitCode = 1;
  } else {
    console.log(`Native thin-UI boundary passed: ${report.nativeSurfaceBindings} App bindings, ${report.nativeComponentFiles} dedicated component files.`);
  }
}
