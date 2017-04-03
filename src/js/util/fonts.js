export const availableFonts = [
  {
    name: 'System',
    key: 'system',
    stack: '-apple-system, BlinkMacSystemFont, "Helvetica Neue", "Segoe UI", "Helvetica", "Roboto", Arial, sans-serif',
  },
];

export const hasFont = (fontKey) => (
  availableFonts.findIndex(font => font.key === fontKey) > -1
);

const getFont = (fontKey) => (
  availableFonts.find(font => font.key === fontKey)
);

export const getCSSForFont = (fontKey) => {
  if (!hasFont(fontKey)) {
    return null;
  }

  const font = getFont(fontKey);

  let string = '';

  if (font.import) {
    string += `
      @import url(${font.import});
    `;
  }

  string += `
    body {
      font-family: ${font.stack};
    }
  `;

  return string;
};
