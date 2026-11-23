// Traduce KeyboardEvent.code (la tecla física en el navegador remoto) al nombre
// de tecla de nut-js. Se usa la posición física, no el carácter, para que la
// distribución de teclado la decida el Mac.

const names = {
  Escape: 'Escape',
  Backquote: 'Grave',
  Minus: 'Minus',
  Equal: 'Equal',
  Backspace: 'Backspace',
  Tab: 'Tab',
  BracketLeft: 'LeftBracket',
  BracketRight: 'RightBracket',
  Backslash: 'Backslash',
  IntlBackslash: 'Grave',
  CapsLock: 'CapsLock',
  Semicolon: 'Semicolon',
  Quote: 'Quote',
  Enter: 'Return',
  Comma: 'Comma',
  Period: 'Period',
  Slash: 'Slash',
  Space: 'Space',
  ShiftLeft: 'LeftShift',
  ShiftRight: 'RightShift',
  ControlLeft: 'LeftControl',
  ControlRight: 'RightControl',
  AltLeft: 'LeftAlt',
  AltRight: 'RightAlt',
  MetaLeft: 'LeftCmd',
  MetaRight: 'RightCmd',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  Insert: 'Insert',
  Delete: 'Delete',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  PrintScreen: 'Print',
  ScrollLock: 'ScrollLock',
  Pause: 'Pause',
  NumLock: 'NumLock',
  NumpadDivide: 'Divide',
  NumpadMultiply: 'Multiply',
  NumpadSubtract: 'Subtract',
  NumpadAdd: 'Add',
  NumpadEnter: 'Enter',
  NumpadDecimal: 'Decimal',
  NumpadEqual: 'NumPadEqual',
  ContextMenu: 'Menu',
};

for (const letter of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') names[`Key${letter}`] = letter;
for (let digit = 0; digit <= 9; digit++) {
  names[`Digit${digit}`] = `Num${digit}`;
  names[`Numpad${digit}`] = `NumPad${digit}`;
}
for (let number = 1; number <= 20; number++) names[`F${number}`] = `F${number}`;

// Teclas que se mandan como modificadores junto con cada pulsación, para que
// combinaciones como Cmd+C lleguen con el flag correcto. Siempre la variante
// izquierda: es la que libnut reconoce como flag.
export const modifierFlags = {
  ShiftLeft: 'LeftShift',
  ShiftRight: 'LeftShift',
  ControlLeft: 'LeftControl',
  ControlRight: 'LeftControl',
  AltLeft: 'LeftAlt',
  AltRight: 'LeftAlt',
  MetaLeft: 'LeftCmd',
  MetaRight: 'LeftCmd',
};

export function keyFor(Key, code) {
  const name = names[code];
  return name && Key[name] !== undefined ? Key[name] : undefined;
}
