import { 
  Box,
  Container,
  Typography
} from '@mui/material';
import { useTheme } from '@mui/material/styles';


function Navbar() {
  const theme = useTheme();
  return (
    <Box 
      sx={{
        width: '100%',
        height:{ lg: '40px', md:'32px' },
        backgroundColor: theme.palette.primary.main,
        display: 'flex',
        alignItems: 'center',
      }}
    >
      <Container
        maxWidth={false}
        sx={{ maxWidth: (theme) => theme.breakpoints.values.laptop, width: '100%' }}
      >
        <Typography variant='h5' fontWeight='400'>
          專案自動外撥監控面板 - 二代
        </Typography>
      </Container>
    </Box>
  );
}
export default Navbar;