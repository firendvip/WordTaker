import path from "node:path";

const chunkGroups = {
  vendor: ["react", "react-dom"],
  ui: ["@radix-ui/react-dialog", "@radix-ui/react-dropdown-menu", "@radix-ui/react-select"],
  utils: ["clsx", "tailwind-merge", "class-variance-authority"],
};

export function getManualChunkName(moduleId) {
  const normalizedId = moduleId.split(path.sep).join("/");

  for (const [chunkName, packages] of Object.entries(chunkGroups)) {
    if (packages.some((packageName) => normalizedId.includes(`/node_modules/${packageName}/`))) {
      return chunkName;
    }
  }

  return undefined;
}
