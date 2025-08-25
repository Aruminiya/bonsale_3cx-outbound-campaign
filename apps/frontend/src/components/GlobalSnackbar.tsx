import { useState, useImperativeHandle, forwardRef } from 'react';
import Snackbar from '@mui/material/Snackbar';
import MuiAlert, { type AlertColor } from '@mui/material/Alert';

export interface GlobalSnackbarRef {
  showSnackbar: (message: string, severity?: AlertColor) => void;
}

const GlobalSnackbar = forwardRef<GlobalSnackbarRef>((_props, ref) => {
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState('');
  const [severity, setSeverity] = useState<AlertColor>('info');

  useImperativeHandle(ref, () => ({
    showSnackbar: (msg: string, sev: AlertColor = 'info') => {
      setMessage(msg);
      setSeverity(sev);
      setOpen(true);
    },
  }));

  const handleClose = () => setOpen(false);

  return (
    <Snackbar
      open={open}
      autoHideDuration={3000}
      onClose={handleClose}
      anchorOrigin={{ vertical: 'bottom', horizontal: 'left' }}
    >
      <MuiAlert
        onClose={handleClose}
        severity={severity}
        elevation={6}
        variant="filled"
        sx={{
          width: '100%',
          bgcolor: (theme) => theme.palette[severity].main,
          color: (theme) => theme.palette[severity].contrastText,
        }}
      >
        {message}
      </MuiAlert>
    </Snackbar>
  );
});

export default GlobalSnackbar;