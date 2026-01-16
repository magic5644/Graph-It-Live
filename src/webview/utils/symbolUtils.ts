export const CATEGORY_COLORS: Record<string, { bg: string; text: string; border: string }> = {
    // FR-010: Classes (deep purple), Functions (vibrant blue), Variables (amber)
    function: { bg: '#4A9EFF', text: '#000', border: '#3680d9' },      // Vibrant blue
    method: { bg: '#4A9EFF', text: '#000', border: '#3680d9' },        // Vibrant blue (same as function)
    class: { bg: '#9966CC', text: '#fff', border: '#7a52a3' },         // Deep purple
    variable: { bg: '#FFA500', text: '#000', border: '#cc8400' },      // Amber
    constant: { bg: '#FFA500', text: '#000', border: '#cc8400' },      // Amber (same as variable)
    property: { bg: '#FFA500', text: '#000', border: '#cc8400' },      // Amber (same as variable)
    field: { bg: '#FFA500', text: '#000', border: '#cc8400' },         // Amber (same as variable)
    interface: { bg: '#b5cea8', text: '#000', border: '#8fa385' },
    type: { bg: '#ce9178', text: '#000', border: '#ac7863' },
    enum: { bg: '#ee9d28', text: '#000', border: '#bd7d20' },
    module: { bg: '#c6c6c6', text: '#000', border: '#9e9e9e' },
    constructor: { bg: '#9966CC', text: '#fff', border: '#7a52a3' },   // Deep purple (same as class)
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
