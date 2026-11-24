// Mirror only installed-font sources from Font Manager's applied @font-face rules.
const localFont = /local\((?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^()"'\\,]+)\)/.source;
const localFonts = new RegExp('^' + localFont + '(?:\\s*,\\s*' + localFont + ')*$', 'i');

const installedFaces = [];
let previous = '[]';

export function applyManagedFontFaces(fontFaces) {
    const faces = Array.isArray(fontFaces) ? fontFaces : [];
    const signature = JSON.stringify(faces);
    if (signature === previous) return false;

    previous = signature;
    for (const face of installedFaces) document.fonts.delete(face);
    installedFaces.length = 0;
    for (const rule of faces) {
        if (!rule || typeof rule.family !== 'string' || typeof rule.source !== 'string' ||
            !localFonts.test(rule.source)) continue;
        const { family, source, weight, style, unicodeRange, display } = rule;
        const face = new FontFace(family, source, { weight, style, unicodeRange, display });
        face.loaded.catch(() => {});
        if (face.status === 'error') continue;
        document.fonts.add(face);
        installedFaces.push(face);
    }
    return true;
}
