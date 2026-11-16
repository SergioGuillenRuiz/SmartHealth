import { isBarcode } from './food-label';

// Códigos de barras de los productos: qué se saca de lo que lee la cámara, qué otros códigos hay que probar para el mismo producto y qué se le
// dice a la persona cuando el código no puede estar en ninguna base (balanza de la tienda, libro, cupón…). Módulo sin dependencias de la interfaz.

/** La cifra de control de un código sin ella (EAN-8, UPC-A, EAN-13 o GTIN-14): pesos 3 y 1 alternos de derecha a izquierda. */
export function checkDigit(body: string): number {
  const sum = [...body].reverse().reduce((total, digit, i) => total + Number(digit) * (i % 2 === 0 ? 3 : 1), 0);
  return (10 - (sum % 10)) % 10;
}

/** Un UPC-E (8 cifras) pasado a UPC-A (12): los ceros que el UPC-E se ahorra vuelven a su sitio según su última cifra antes de la de control. */
export function expandUpcE(upcE: string): string | null {
  if (!/^[01]\d{7}$/.test(upcE)) return null;
  const system = upcE[0]!;
  const d = upcE.slice(1, 7);
  const check = upcE[7]!;
  const last = d[5]!;
  let body: string;
  if (last === '0' || last === '1' || last === '2') body = `${d.slice(0, 2)}${last}0000${d.slice(2, 5)}`;
  else if (last === '3') body = `${d.slice(0, 3)}00000${d.slice(3, 5)}`;
  else if (last === '4') body = `${d.slice(0, 4)}00000${d[4]}`;
  else body = `${d.slice(0, 5)}0000${last}`;
  const expanded = `${system}${body}${check}`;
  return isBarcode(expanded) ? expanded : null;
}

/**
 * El código de producto que escribió la persona: solo cifras (con o sin espacios y guiones), con su cifra de control. Un UPC-E de 8 cifras (que no
 * es un EAN-8 válido) se pasa a UPC-A. `null` si no es un código.
 */
export function typedBarcode(text: string): string | null {
  const digits = text.replace(/[\s-]/g, '');
  if (isBarcode(digits)) return digits;
  return /^\d{8}$/.test(digits) ? expandUpcE(digits) : null;
}

/** El identificador de aplicación 01 (el GTIN) de GS1: entre paréntesis, o al principio del texto de un DataMatrix (que no los lleva, y sigue con otros datos sin separar). */
const GS1_PAREN = /\(01\)(\d{14})/;
const GS1_RAW = /^01(\d{14})/;
const DIGITAL_LINK = /\/01\/(\d{14})(?!\d)/;

/**
 * El código de producto (GTIN) que hay en lo que leyó ZXing: las cifras tal cual (EAN-13, EAN-8, UPC-A, UPC-E ya pasado a 13, ITF-14), o dentro de un
 * código GS1 (DataBar, Code 128, DataMatrix: `(01)08410000000016…` o `0108410000000016…`) o de un enlace GS1 (`…/01/08410000000016/…`). `null` si no hay ninguno
 * válido: el texto de un QR cualquiera no es un producto.
 */
export function gtinFromScan(text: string): string | null {
  const plain = text.trim();
  if (isBarcode(plain)) return plain;
  const link = DIGITAL_LINK.exec(plain);
  if (link && isBarcode(link[1]!)) return link[1]!;
  // «(01)08410000000016(17)…» o «0108410000000016…»: la cifra de control del GTIN es lo que da por bueno el resto.
  const ai = GS1_PAREN.exec(plain) ?? GS1_RAW.exec(plain);
  if (ai && isBarcode(ai[1]!)) return ai[1]!;
  return null;
}

/**
 * Los códigos con que probar un producto, en orden. Un GTIN-14 con una cifra de «unidad logística» que no es 0 (el de una caja de 12 yogures, el de un
 * palé) lleva dentro el código de la unidad de consumo: las 12 cifras de en medio y su cifra de control.
 */
export function lookupCodes(code: string): string[] {
  const codes = [code];
  if (/^\d{14}$/.test(code) && code[0] !== '0') {
    const inner = code.slice(1, 13);
    codes.push(`${inner}${checkDigit(inner)}`);
  }
  return codes;
}

/**
 * Por qué un código no puede estar en una base de productos, o `null` si podría estarlo. Los de la tienda (prefijos 02, 04, 20 a 29: las etiquetas de la balanza
 * de la charcutería, la carnicería o la fruta llevan el peso o el precio dentro), los de libros y revistas (977, 978, 979) y los de cupones (981 a 999) no
 * identifican un producto.
 */
export function unlistedReason(code: string): string | null {
  const ean13 = /^\d{12,13}$/.test(code) ? code.padStart(13, '0') : /^0\d{13}$/.test(code) ? code.slice(1) : null;
  if (ean13 === null) return null;
  if (/^(02|04|2\d)/.test(ean13)) {
    return 'Es un código de la propia tienda (el de la etiqueta de la balanza o de un producto sin marca): lleva el peso o el precio y no identifica un producto en ninguna base. Descríbelo con palabras.';
  }
  if (/^97[789]/.test(ean13)) return 'Es el código de un libro o una revista, no el de un alimento.';
  if (/^(05|9(8[1-9]|9\d))/.test(ean13)) return 'Es un código de cupón, no el de un producto.';
  return null;
}

/**
 * Los códigos válidos que se parecen al tecleado en una sola cifra (se equivocó al teclear): para sugerir «¿era este?» cuando el código tecleado no
 * tiene bien su cifra de control. Con la cifra de control sola mal, solo hay uno (corregirla); si no, los que cambian una cifra y quedan válidos.
 */
export function neighbourCodes(code: string): string[] {
  if (!/^\d{8}$|^\d{12,14}$/.test(code) || isBarcode(code)) return [];
  const out = new Set<string>();
  const body = code.slice(0, -1);
  out.add(`${body}${checkDigit(body)}`);
  for (let at = 0; at < code.length; at++) {
    for (let digit = 0; digit <= 9; digit++) {
      if (String(digit) === code[at]) continue;
      const candidate = `${code.slice(0, at)}${digit}${code.slice(at + 1)}`;
      if (isBarcode(candidate)) out.add(candidate);
    }
  }
  return [...out];
}
