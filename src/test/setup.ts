import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// Auto-unmount + clean DOM after every test
afterEach(() => {
  cleanup();
});
