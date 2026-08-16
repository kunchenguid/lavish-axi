import { isEndSessionHotkeyEvent } from "./review-hotkeys.js";

export function createWhiteboardEndSessionHotkeyHandler(getMode, postMessage) {
  return (event) => {
    if (getMode() !== "overlay" || !isEndSessionHotkeyEvent(event)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    postMessage({ type: "lavish-whiteboard:endSession" });
  };
}
