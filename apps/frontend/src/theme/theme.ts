import '@mui/material/styles';
declare module '@mui/material/styles' {
  interface PaletteColor {
    color50?: string;
    color100?: string;
    color200?: string;
    color300?: string;
    color400?: string;
    color600?: string;
    color700?: string;
    color800?: string;
    color900?: string;
  }
}

const theme = {
  mode: 'light',
  typography: {
    fontFamily: ['Roboto', 'Noto Sans TC', 'sans-serif'].join(','),
  },
  palette: {
    primary: {
      main: '#7BA9C6',
      light: '#9FC1D6',
      dark: '#4B7A95',
      color50: '#DFEBF1',
      color100: '#D5E3ED',
      color200: '#C7DBE7',
      color300: '#B4CEDF',
      color400: '#9BBED4',
      color600: '#5893B8',
      color700: '#457EA2',
      color800: '#3B6B89',
      color900: '#325B75'
    },
    secondary: {
      main: '#89D0DF',
      light: '#BCFFFF',
      dark: '#579FAD',
      color50: '#E3F4F7',
      color100: '#DAF0F5',
      color200: '#CDEBF1',
      color300: '#BDE5ED',
      color400: '#A7DCE7',
      color600: '#5FC0D3',
      color700: '#3AB2CA',
      color800: '#2F99AE',
      color900: '#288294'
    },
    error: {
      main: '#FF4D4D',
      light: '#FF8279',
      dark: '#C50024',
      color50: '#FFD5D5',
      color100: '#FFB3B3',
      color200: '#FF8C8C',
      color300: '#FF6666',
      color400: '#FF4D4D', 
      color600: '#C50024', 
      color700: '#A5001E',
      color800: '#8A0017',
      color900: '#7A0014'
    },
    warning: {
      main: '#F2C055',
      light: '#FFF285',
      dark: '#BC9024',
      color50: '#FDF2DD',
      color100: '#FDEDD1',
      color200: '#FBE8C2',
      color300: '#F9E0AD',
      color400: '#F8D692',
      color600: '#F2B43D',
      color700: '#EFA514',
      color800: '#CC8D0D',
      color900: '#AD780D'
    },
    info: {
      main: '#6CC0C0',
      light: '#90D0D0',
      dark: '#4BAFAF',
    },
    success: {
      main: '#70DCAD',
      light: '#A4FFDF',
      dark: '#3BA97D',
      color50: '#DDF7ED',
      color100: '#CFF1E0',
      color200: '#B2E4D1', 
      color300: '#8DD6B7',
      color400: '#70DCAD',
      color600: '#4BA97D',
      color700: '#3BA97D',
      color800: '#2D8A6B',
      color900: '#2A7B5E'
    },
    text: {
      primary: 'rgba(0,0,0,0.8)',
      secondary: 'rgba(0,0,0,0.6)',
      disabled: 'rgba(0,0,0,0.38)',
    },
    action: {
      active: 'rgba(0,0,0,0.54)',
      hover: 'rgba(0,0,0,0.04)',
      selected: 'rgba(0,0,0,0.08)',
      disabled: 'rgba(0,0,0,0.26)',
      disabledBackground: 'rgba(0,0,0,0.12)',
      focus: 'rgba(0,0,0,0.12)',
    },
    background: {
      default: '#FAFAFA',
      paper: '#FFFFFF',
    },
  },
}

export default theme
