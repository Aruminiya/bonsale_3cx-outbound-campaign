import { Button, Dialog, DialogActions, DialogContent, DialogContentText, DialogTitle, Pagination, Stack } from '@mui/material';
import { useEffect, useState, useCallback } from 'react';
import CustomerDetailsTable from './CustomerDetailsTable';
import useGetBonsaleProject from '../hooks/api/useGetBonsaleProject';
import useGetBonsaleProjectCountCustomer from '../hooks/api/useGetBonsaleProjectCountCustomer';

type ProjectCustomersDialogProps = {
  onOpen: boolean;
  onClose?: () => void;
  projectId: string | null;
};

export default function ProjectCustomersDialog({ onOpen, onClose, projectId }: ProjectCustomersDialogProps) {
  const [open, setOpen] = useState(false);
  const [projectCustomersDesc, setProjectCustomersDesc] = useState<ProjectCustomersDesc[]>([]);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const { getBonsaleProject, isLoading: getBonsaleProjectIsLoading } = useGetBonsaleProject();
  const { getBonsaleProjectCountCustomer } = useGetBonsaleProjectCountCustomer();

  const handleClose = () => {
    setOpen(false);
    if (onClose) {
      onClose();
    }
  };

const fetchCustomerCount = useCallback(async () => {
  if (!projectId) return;
  try {
    const count = await getBonsaleProjectCountCustomer(projectId);
    console.log('Customer count:', count.totalPage);
    setTotalPages(count.totalPage); // 這裡要用 totalPage（單數）
  } catch (error) {
    console.error('Error fetching customer count:', error);
  }
}, [getBonsaleProjectCountCustomer, projectId]);

  const fetchCustomers = useCallback(async (pageNum = 1) => {
    if (!projectId) return;
    const customers = await getBonsaleProject(projectId, pageNum);
    setProjectCustomersDesc(customers.list);
  }, [getBonsaleProject, projectId]);

  useEffect(() => {
    if (onOpen && projectId) {
      setPage(1);
      fetchCustomerCount();
      fetchCustomers(1);
    } else {
      setProjectCustomersDesc([]);
    }
  }, [onOpen, projectId, fetchCustomers, fetchCustomerCount]);

  useEffect(() => {
    setOpen(onOpen);
  }, [onOpen]);

  return (
    <Dialog
      open={open}
      onClose={handleClose}
      aria-labelledby="ProjectCustomersDialog-title"
      aria-describedby="ProjectCustomersDialog-description"
      PaperProps={{
        sx: { width: 600, height: '100%' }
      }}
    >
      <DialogTitle id="alert-dialog-title">
        專案名單撥打狀態
      </DialogTitle>
      <DialogContent>
        <DialogContentText component="div" id="alert-dialog-description">
          <Stack direction="row" justifyContent="end" sx={{ mt: 2 }}>
            <Pagination
              count={totalPages}
              page={page}
              onChange={(_, value) => {
                setPage(value);
                fetchCustomerCount();
                fetchCustomers(value); // 這裡載入新頁資料
              }}
              color="primary"
              size="small"
            />
          </Stack>
          <CustomerDetailsTable projectCustomersDesc={projectCustomersDesc} getBonsaleProjectIsLoading={getBonsaleProjectIsLoading} />
        </DialogContentText>
      </DialogContent>
      <DialogActions>
        <Button 
          onClick={handleClose}
          variant="contained"
        >
          確認
        </Button>
      </DialogActions>
    </Dialog>
  );
}