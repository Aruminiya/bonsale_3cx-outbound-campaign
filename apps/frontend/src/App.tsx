import Router from "./router/Router.tsx";
import { createTheme, ThemeProvider } from '@mui/material/styles';
import theme from './theme/theme.ts';
import custom from "./theme/custom.ts";

import { Box, Container } from '@mui/material';
import Navbar from './components/Navbar';

const muiTheme = createTheme(theme, custom);

// 取得本機 IP domain
const { hostname } = window.location;
const api_protocol = import.meta.env.VITE_API_PROTOCOL;
const port = import.meta.env.VITE_API_PORT;
const domain = import.meta.env.VITE_DOMAIN;
const HTTP_HOST = domain === 'localhost'? `${api_protocol}://${hostname}:${port}` :`${api_protocol}://${domain}:${port}`;
console.log('HTTP_HOST:', HTTP_HOST);
const VITE_ENV = import.meta.env.VITE_ENV;
console.log('VITE_ENV:', VITE_ENV);

function App() {
  return (
    <ThemeProvider theme={muiTheme}>
      <Box 
        sx={{
          display: 'flex',
          flexDirection: 'column',
          height: '100vh',
          backgroundColor: (theme) => theme.palette.background.default,
          color: (theme) => theme.palette.text.primary,
        }}
      >
        <Box sx={{ flex: 0, flexDirection: 'column' }}>
          <Navbar />
        </Box>
        <Container
          maxWidth={false}
          sx={{
            position:'relative',
            flex: 1,
            display:'flex',
            flexDirection: 'column',
            height:'100%',
            overflowY:'hidden', 
            maxWidth: (theme) => theme.breakpoints.values.laptop, width: '100%' 
          }}
        >
          <Router />
        </Container>
        <Box
          sx={{
            position: 'absolute',
            bottom: 8,
            right: 16,
            fontSize: '0.75rem',
            color: (theme) => theme.palette.text.secondary,
            opacity: 0.7,
            zIndex: 10,
            pointerEvents: 'none',
          }}
        >
          v1.0.1
        </Box>
      </Box>
    </ThemeProvider>
  )
}

export default App
