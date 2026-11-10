import { useColorScheme } from 'react-native';

const light = {
  background: '#f7f7f5',
  surface: '#ffffff',
  surfaceMuted: '#efefec',
  text: '#1c1c1a',
  muted: '#6b6b66',
  border: '#e2e2dd',
  accent: '#5b4bdb',
  accentText: '#ffffff',
  userBubble: '#5b4bdb',
  userText: '#ffffff',
  danger: '#c0362c',
  success: '#1f7a4d',
};
const dark: typeof light = {
  background: '#121211',
  surface: '#1c1c1a',
  surfaceMuted: '#262624',
  text: '#f1f1ee',
  muted: '#a3a39d',
  border: '#33332f',
  accent: '#8b7ff0',
  accentText: '#121211',
  userBubble: '#8b7ff0',
  userText: '#121211',
  danger: '#ef6b61',
  success: '#5cc58e',
};
export type Theme = typeof light;

export function useTheme(): Theme {
  return useColorScheme() === 'dark' ? dark : light;
}
