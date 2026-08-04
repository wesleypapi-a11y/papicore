/*
 * themePresets.js
 *
 * Fonte única dos temas de cores prontos para a aba Aparência do admin do
 * tenant. Backend e frontend nunca hardcodam esses valores em outro lugar —
 * o frontend só recebe a lista pronta via GET /api/admin/branding
 * (available_themes) e o backend valida theme_key contra THEME_KEYS antes de
 * salvar. Não aceita cores arbitrárias nesta primeira versão.
 */

const THEME_PRESETS = [
  {
    key: 'papicore-orange',
    name: 'PapiCore Orange',
    description: 'Laranja, preto e cinza.',
    colors: {
      primary: '#FF7A00',
      secondary: '#111827',
      accent: '#FF9A3D',
      background: '#090D14',
      surface: '#151B26',
      text: '#F8FAFC',
      muted: '#94A3B8',
      border: '#2A3342',
      success: '#22C55E',
      danger: '#EF4444'
    }
  },
  {
    key: 'ocean-blue',
    name: 'Ocean Blue',
    description: 'Azul moderno e profissional.',
    colors: {
      primary: '#2563EB',
      secondary: '#0F172A',
      accent: '#38BDF8',
      background: '#08111F',
      surface: '#111C2E',
      text: '#F8FAFC',
      muted: '#94A3B8',
      border: '#24334A',
      success: '#22C55E',
      danger: '#EF4444'
    }
  },
  {
    key: 'emerald-green',
    name: 'Emerald Green',
    description: 'Verde elegante e tecnológico.',
    colors: {
      primary: '#10B981',
      secondary: '#0F172A',
      accent: '#34D399',
      background: '#071510',
      surface: '#10221A',
      text: '#F8FAFC',
      muted: '#A3B3AA',
      border: '#244136',
      success: '#22C55E',
      danger: '#EF4444'
    }
  },
  {
    key: 'royal-purple',
    name: 'Royal Purple',
    description: 'Roxo sofisticado e premium.',
    colors: {
      primary: '#7C3AED',
      secondary: '#111827',
      accent: '#A78BFA',
      background: '#0E0A16',
      surface: '#1B142A',
      text: '#F8FAFC',
      muted: '#A8A0B8',
      border: '#35294A',
      success: '#22C55E',
      danger: '#EF4444'
    }
  },
  {
    key: 'crimson-red',
    name: 'Crimson Red',
    description: 'Vermelho forte e esportivo.',
    colors: {
      primary: '#DC2626',
      secondary: '#111827',
      accent: '#FB7185',
      background: '#14090B',
      surface: '#241216',
      text: '#F8FAFC',
      muted: '#B8A1A5',
      border: '#4A252B',
      success: '#22C55E',
      danger: '#EF4444'
    }
  }
];

const DEFAULT_THEME_KEY = 'papicore-orange';

const THEME_KEYS = THEME_PRESETS.map((t) => t.key);

function getThemePreset(themeKey) {
  return THEME_PRESETS.find((t) => t.key === themeKey) || null;
}

function getDefaultThemePreset() {
  return getThemePreset(DEFAULT_THEME_KEY);
}

module.exports = {
  THEME_PRESETS,
  THEME_KEYS,
  DEFAULT_THEME_KEY,
  getThemePreset,
  getDefaultThemePreset
};
