import colors from './colors'
import '@mui/material/styles';
declare module '@mui/material/styles' {
  interface BreakpointOverrides {
    xs: true;
    sm: true;
    md: true;
    lg: true;
    xl: true;
    tablet: true;
    laptop: true;
  }
}

const custom = {
  breakpoints: {
    values: {
      xs: 0,
      sm: 600,
      md: 900,
      lg: 1200,
      xl: 1536,
      tablet: 1024,
      laptop: 1280,
    },
  },
  mixins: {
    backdrop: {
      position: 'absolute',
      top: 0,
      left: 0,
      width: '100%',
      height: '100%',
      zIndex: 2,
    },
    scrollbar: {
      '&::-webkit-scrollbar': {
        width: '.75rem',
        height: '.75rem',
      },
      '&::-webkit-scrollbar-track': {
        background: colors.background.default,
      },
      '&::-webkit-scrollbar-thumb': {
        background: colors.action.disabled,
        borderRadius: '5px',
        border: '2px solid transparent',
        backgroundClip: 'padding-box',

        '&:hover': {
          background: colors.primary.dark,
          border: 0,
        },
      },
    },
  },
} as const

export default custom