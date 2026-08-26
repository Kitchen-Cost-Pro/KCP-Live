export const DEFAULT_RESTAURANT_THEME_ID = 'kcp-classic';
export const DEFAULT_RESTAURANT_BACKGROUND_ID = 'kcp-classic';

export const RESTAURANT_THEME_PRESETS = [
  {
    id: 'kcp-classic',
    label: 'Kitchen Pass',
    description: 'A focused kitchen pass backdrop for daily operations.',
    category: 'basic',
    backgroundImage: '/theme-backgrounds/kitchen-pass.png',
    backgroundPosition: 'center',
    preview: ['#60a5fa', '#34d399', '#101c2b'],
    light: {
      '--accent-blue': '#2563eb',
      '--accent-indigo': '#4f46e5',
      '--accent-cyan': '#0891b2',
      '--accent-emerald': '#059669',
      '--accent-amber': '#d97706',
      '--accent-orange': '#ea580c'
    },
    dark: {
      '--accent-blue': '#60a5fa',
      '--accent-indigo': '#818cf8',
      '--accent-cyan': '#22d3ee',
      '--accent-emerald': '#34d399',
      '--accent-amber': '#f59e0b',
      '--accent-orange': '#fb923c'
    }
  },
  {
    id: 'chef-pass',
    label: 'Chef Station',
    description: 'Stainless pass, prep boards, and service light.',
    category: 'hospitality',
    backgroundImage: '/theme-backgrounds/chef-station.png',
    backgroundPosition: 'center',
    preview: ['#38bdf8', '#22c55e', '#f97316'],
    light: {
      '--accent-blue': '#0284c7',
      '--accent-indigo': '#475569',
      '--accent-cyan': '#0f766e',
      '--accent-emerald': '#16a34a',
      '--accent-amber': '#d97706',
      '--accent-orange': '#ea580c'
    },
    dark: {
      '--bg-primary': '#07131b',
      '--bg-secondary': '#0d1f2a',
      '--surface-primary': '#102333',
      '--surface-secondary': '#0a1924',
      '--surface-elevated': '#142a3d',
      '--accent-blue': '#38bdf8',
      '--accent-indigo': '#94a3b8',
      '--accent-cyan': '#2dd4bf',
      '--accent-emerald': '#22c55e',
      '--accent-amber': '#f59e0b',
      '--accent-orange': '#fb923c'
    }
  },
  {
    id: 'espresso-bar',
    label: 'Coffee Bar',
    description: 'Warm counter lighting with espresso service detail.',
    category: 'hospitality',
    backgroundImage: '/theme-backgrounds/coffee-bar.png',
    backgroundPosition: 'center',
    preview: ['#a16207', '#0ea5e9', '#3f2a1d'],
    light: {
      '--accent-blue': '#0ea5e9',
      '--accent-indigo': '#7c3aed',
      '--accent-cyan': '#0891b2',
      '--accent-emerald': '#047857',
      '--accent-amber': '#a16207',
      '--accent-orange': '#c2410c'
    },
    dark: {
      '--bg-primary': '#120f0c',
      '--bg-secondary': '#1d1712',
      '--surface-primary': '#211a14',
      '--surface-secondary': '#16110d',
      '--surface-elevated': '#2b2118',
      '--border-subtle': '#3c3025',
      '--border-strong': '#5a4938',
      '--accent-blue': '#38bdf8',
      '--accent-indigo': '#a78bfa',
      '--accent-cyan': '#22d3ee',
      '--accent-emerald': '#34d399',
      '--accent-amber': '#fbbf24',
      '--accent-orange': '#fb923c'
    }
  },
  {
    id: 'wine-cellar',
    label: 'Wine Room',
    description: 'Premium cellar shelves and low ambient light.',
    category: 'hospitality',
    backgroundImage: '/theme-backgrounds/wine-room.png',
    backgroundPosition: 'center',
    preview: ['#be123c', '#a78bfa', '#2e1020'],
    light: {
      '--accent-blue': '#7c3aed',
      '--accent-indigo': '#9333ea',
      '--accent-cyan': '#0891b2',
      '--accent-emerald': '#059669',
      '--accent-amber': '#b45309',
      '--accent-orange': '#be123c'
    },
    dark: {
      '--bg-primary': '#100915',
      '--bg-secondary': '#1a1024',
      '--surface-primary': '#21162d',
      '--surface-secondary': '#150d1f',
      '--surface-elevated': '#2a1b3a',
      '--border-subtle': '#3b2b4c',
      '--border-strong': '#59406f',
      '--accent-blue': '#a78bfa',
      '--accent-indigo': '#c084fc',
      '--accent-cyan': '#67e8f9',
      '--accent-emerald': '#34d399',
      '--accent-amber': '#fbbf24',
      '--accent-orange': '#fb7185'
    }
  },
  {
    id: 'market-garden',
    label: 'Market Prep',
    description: 'Fresh produce, prep surfaces, and natural light.',
    category: 'hospitality',
    backgroundImage: '/theme-backgrounds/market-prep.png',
    backgroundPosition: 'center',
    preview: ['#22c55e', '#84cc16', '#164e63'],
    light: {
      '--accent-blue': '#0284c7',
      '--accent-indigo': '#4f46e5',
      '--accent-cyan': '#0e7490',
      '--accent-emerald': '#16a34a',
      '--accent-amber': '#ca8a04',
      '--accent-orange': '#ea580c'
    },
    dark: {
      '--bg-primary': '#06130f',
      '--bg-secondary': '#0b2119',
      '--surface-primary': '#10291f',
      '--surface-secondary': '#071a14',
      '--surface-elevated': '#143527',
      '--border-subtle': '#224334',
      '--border-strong': '#35624d',
      '--accent-blue': '#38bdf8',
      '--accent-indigo': '#818cf8',
      '--accent-cyan': '#2dd4bf',
      '--accent-emerald': '#4ade80',
      '--accent-amber': '#facc15',
      '--accent-orange': '#fb923c'
    }
  },
  {
    id: 'bakery-case',
    label: 'Bakery Counter',
    description: 'Pastry counter warmth with display-case depth.',
    category: 'hospitality',
    backgroundImage: '/theme-backgrounds/bakery-counter.png',
    backgroundPosition: 'center',
    preview: ['#f59e0b', '#38bdf8', '#7c2d12'],
    light: {
      '--accent-blue': '#2563eb',
      '--accent-indigo': '#7c3aed',
      '--accent-cyan': '#0891b2',
      '--accent-emerald': '#059669',
      '--accent-amber': '#d97706',
      '--accent-orange': '#ea580c'
    },
    dark: {
      '--bg-primary': '#120f08',
      '--bg-secondary': '#1e180d',
      '--surface-primary': '#241d10',
      '--surface-secondary': '#171207',
      '--surface-elevated': '#302712',
      '--border-subtle': '#40351c',
      '--border-strong': '#5c4b28',
      '--accent-blue': '#60a5fa',
      '--accent-indigo': '#a78bfa',
      '--accent-cyan': '#22d3ee',
      '--accent-emerald': '#34d399',
      '--accent-amber': '#fbbf24',
      '--accent-orange': '#fb923c'
    }
  },
  {
    id: 'ocean-bistro',
    label: 'Ocean Bistro',
    description: 'Fresh seafood counter blues.',
    category: 'hospitality',
    backgroundImage: '/theme-backgrounds/ocean-bistro.svg',
    preview: ['#06b6d4', '#3b82f6', '#0f766e'],
    light: {
      '--accent-blue': '#0284c7',
      '--accent-indigo': '#2563eb',
      '--accent-cyan': '#06b6d4',
      '--accent-emerald': '#0f766e',
      '--accent-amber': '#d97706',
      '--accent-orange': '#f97316'
    },
    dark: {
      '--bg-primary': '#06111f',
      '--bg-secondary': '#0b1d30',
      '--surface-primary': '#102338',
      '--surface-secondary': '#07182a',
      '--surface-elevated': '#132d46',
      '--border-subtle': '#24415c',
      '--border-strong': '#365d7c',
      '--accent-blue': '#38bdf8',
      '--accent-indigo': '#60a5fa',
      '--accent-cyan': '#22d3ee',
      '--accent-emerald': '#2dd4bf',
      '--accent-amber': '#f59e0b',
      '--accent-orange': '#fb923c'
    }
  },
  {
    id: 'basic-green',
    label: 'Basic Green',
    description: 'Simple green accent.',
    category: 'basic',
    backgroundImage: '/theme-backgrounds/basic-green.svg',
    preview: ['#22c55e', '#60a5fa', '#101c2b'],
    light: {
      '--accent-blue': '#16a34a',
      '--accent-indigo': '#2563eb',
      '--accent-cyan': '#0891b2',
      '--accent-emerald': '#059669',
      '--accent-amber': '#d97706',
      '--accent-orange': '#ea580c'
    },
    dark: {
      '--accent-blue': '#4ade80',
      '--accent-indigo': '#60a5fa',
      '--accent-cyan': '#22d3ee',
      '--accent-emerald': '#34d399',
      '--accent-amber': '#f59e0b',
      '--accent-orange': '#fb923c'
    }
  },
  {
    id: 'basic-purple',
    label: 'Basic Purple',
    description: 'Simple purple accent.',
    category: 'basic',
    backgroundImage: '/theme-backgrounds/basic-purple.svg',
    preview: ['#a78bfa', '#38bdf8', '#101c2b'],
    light: {
      '--accent-blue': '#7c3aed',
      '--accent-indigo': '#6d28d9',
      '--accent-cyan': '#0891b2',
      '--accent-emerald': '#059669',
      '--accent-amber': '#d97706',
      '--accent-orange': '#ea580c'
    },
    dark: {
      '--accent-blue': '#a78bfa',
      '--accent-indigo': '#c084fc',
      '--accent-cyan': '#22d3ee',
      '--accent-emerald': '#34d399',
      '--accent-amber': '#f59e0b',
      '--accent-orange': '#fb923c'
    }
  }
];

const themeVariableNames = [...new Set(RESTAURANT_THEME_PRESETS.flatMap((preset) => [
  ...Object.keys(preset.light || {}),
  ...Object.keys(preset.dark || {})
]))];

export const RESTAURANT_BACKGROUND_PRESETS = RESTAURANT_THEME_PRESETS.slice(0, 6).map((preset) => ({
  id: preset.id,
  label: preset.label,
  description: preset.description,
  backgroundImage: preset.backgroundImage,
  backgroundPosition: preset.backgroundPosition || 'center'
}));

export function getRestaurantThemePreset(themeId = DEFAULT_RESTAURANT_THEME_ID) {
  return RESTAURANT_THEME_PRESETS.find((preset) => preset.id === themeId) || RESTAURANT_THEME_PRESETS[0];
}

export function getRestaurantBackgroundPreset(backgroundId = DEFAULT_RESTAURANT_BACKGROUND_ID) {
  return RESTAURANT_BACKGROUND_PRESETS.find((preset) => preset.id === backgroundId) || RESTAURANT_BACKGROUND_PRESETS[0];
}

export function getRestaurantThemeVariableNames() {
  return themeVariableNames;
}
