import { Buffer } from "buffer";
import { createRoot } from "react-dom/client";

Object.assign(globalThis, { Buffer });

void import("./App").then(({ App }) => {
  createRoot(document.getElementById("root")!).render(<App />);
});
