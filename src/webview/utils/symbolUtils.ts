export const CATEGORY_COLORS: Record<string, { bg: string; text: string; border: string }> = {
    function: { bg: '#4ec9b0', text: '#000', border: '#3b9e8b' },
    method: { bg: '#b180f7', text: '#000', border: '#8d66c5' },
    class: { bg: '#4fc1ff', text: '#000', border: '#3a9acb' },
    variable: { bg: '#9cdcfe', text: '#000', border: '#7ab0d6' },
    constant: { bg: '#4fc1ff', text: '#000', border: '#3a9acb' },
    property: { bg: '#9cdcfe', text: '#000', border: '#7ab0d6' },
    field: { bg: '#9cdcfe', text: '#000', border: '#7ab0d6' },
    interface: { bg: '#b5cea8', text: '#000', border: '#8fa385' },
    type: { bg: '#ce9178', text: '#000', border: '#ac7863' },
    enum: { bg: '#ee9d28', text: '#000', border: '#bd7d20' },
    module: { bg: '#c6c6c6', text: '#000', border: '#9e9e9e' },
    constructor: { bg: '#b180f7', text: '#000', border: '#8d66c5' },
    other: { bg: '#c586c0', text: '#000', border: '#9e6b9a' },
};

export const CATEGORY_ICONS: Record<string, string> = {
    function: 'ƒ',
    method: 'm',
    class: 'C',
    variable: 'v',
    constant: 'c',
    property: 'p',
    field: 'f',
    interface: 'I',
    type: 'T',
    enum: 'E',
    module: 'M',
    constructor: '⊗',
    other: '?',
};

export function getSymbolStyle(category: string) {
    const defaultStyle = CATEGORY_COLORS.other;
    return CATEGORY_COLORS[category] || defaultStyle;
}
