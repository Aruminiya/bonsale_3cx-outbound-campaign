import { 
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  Chip,
  LinearProgress,
} from '@mui/material';

export default function CustomerDetailsTable({ projectCustomersDesc, getBonsaleProjectIsLoading }: { projectCustomersDesc: ProjectCustomersDesc[], getBonsaleProjectIsLoading: boolean }) {
  return (
    <Table size="small" sx={{ marginTop: '16px' }}>
      <TableHead>
        <TableRow>
          <TableCell>客戶姓名</TableCell>
          <TableCell>電話</TableCell>
          <TableCell>撥打狀態</TableCell>
        </TableRow>
      </TableHead>
      <TableBody>
        {
          getBonsaleProjectIsLoading ?
            <TableRow>
              <TableCell colSpan={8} sx={{ padding: 0 }}>
                <LinearProgress />
              </TableCell>
            </TableRow>
          : projectCustomersDesc.length == 0 &&
            <TableRow>
              <TableCell colSpan={3} align="center" sx={{ borderBottom: 'none' , color: '#888', py: 4, fontSize: '1.5rem' }}>
                沒有名單
              </TableCell>
            </TableRow>
        }
        {projectCustomersDesc.map((desc, index) => (
          <TableRow key={index}>
            <TableCell>{desc.customer?.memberName || '未知'}</TableCell>
            <TableCell>{desc.customer?.phone || '無電話'}</TableCell>
            <TableCell>
            <Chip
              label={
                desc.callStatus === 0 ? '初始值' : 
                desc.callStatus === 1 ? '成功接通' :
                desc.callStatus === 2 ? '不成功接通' : 
                '未知的狀態'
              }
              color={
                desc.callStatus === 0 ? 'default' : 
                desc.callStatus === 1 ? 'success' :
                desc.callStatus === 2 ? 'error' : 
                'default'
              }
              size="small"
              sx={{ marginBottom: '4px' }}
            />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
};