/** Whether the keyboard is in a text field or menu (so app shortcuts should stay out of the way). */
export function isTyping() {
  return ["INPUT", "SELECT", "TEXTAREA"].includes(document.activeElement?.tagName);
}
