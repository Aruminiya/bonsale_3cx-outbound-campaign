type User = {
  id: string;
  createdAt: string;
  createdUsername: string;
  updatedAt: string;
  updatedUsername: string;
  deletedAt?: string;
  deletedUsername?: string;
  username: string;
  displayName: string;
  role: "admin" | string;
  position: string;
  zone: string;
  supervisorUsername: string;
  supervisorUser: {
    userId: string;
    realName: string;
  };
  phone: string;
  isEnable: boolean;
  isProtect: boolean;
  isAssign: boolean;
  path: string;
  userId: string;
  realName: string;
  fullAccess: number;
  securityRoles: {
    secRoleId: number;
    secRoleName: string;
    descritpion: string;
  };
  salePointId: string;
  salePoint: SalePoint;
  salePointIds: string;
  departmentId: string;
  department: {
    id: string;
    code: string;
    name: string;
  };
  isLook: number;
  isDoctor: number;
  isMaster: number;
  isReturn: number;
  customerId: string;
  contact: {
    id: string;
    contactName: string;
    memberId: string;
    contactAddressZip: string;
    contactAddressCounty: string;
    contactAddressCity: string;
    contactAddressStreet: string;
    userId: string;
  };
  tags: Tag[];
}

type LocationType = {
  id: string;
  typeName: string;
  itemIndex: number;
  description: string;
  code: string;
  createUserId: string;
  createUserName: string;
  createTime: string;
  modifyUserId: string;
  modifyUserName: string;
  modifyTime: string;
  deleted: number;
}

type Location = {
  locCode: string;
  locationName: string;
  locationTypeId: string;
  locationType: LocationType;
}

type SalePoint = {
  id: string;
  residenceAddressCounty: string;
  residenceAddressZip: string;
  residenceAddressCity: string;
  residenceAddressStreet: string;
  salePointName: string;
  salePointCode: string;
  salePointTypeId: string;
  locationCode: string;
  location: Location;
  salesTypesTypeAbbrev: string;
  createUserId: string;
  createUserName: string;
  createTime: string;
  modifyUserId: string;
  modifyUserName: string;
  modifyTime: string;
  returnLocationCode: string;
  returnLocation: Location;
  sampleLocationCode: string;
  sampleLocation: Location;
  departmentId: string;
  headTime: string;
  invoiceHead1: string;
  invoiceHead2: string;
  invoiceHead3: string;
  invoiceHead4: string;
  invoiceHead5: string;
  invoiceHead6: string;
  salePointInvoiceName: string;
  isLock: number;
  startDate: string;
}

type Tag = {
  id: string;
  createdAt: string;
  createdUsername: string;
  updatedAt: string;
  updatedUsername: string;
  deletedAt?: string;
  deletedUsername?: string;
  seq: number;
  tagName: string;
  description: string;
  color: string;
  isEnable: boolean;
}

type Project = {
  id: string;
  projectName: string;
  description: string;
  startDate: string;
  endDate: string;
  isEnable: boolean;
  isParent: boolean;
  parentProjectId: string;
  parentProject: string;
  faqs: FAQ[];
}

type FAQ = {
  id: string;
  createdAt: string;
  createdUsername: string;
  updatedAt: string;
  updatedUsername: string;
  deletedAt?: string;
  projectId: string;
  seq: number;
  question: string;
  answer: string;
  isEnable: boolean;
}

type Customer = {
  id: string;
  memberName: string;
  phone: string;
}

type VisitRecord = {
  id: string;
  createdAt: string;
  createUsername: string;
  createdUser: User;
  updatedAt: string;
  updatedUsername: string;
  updatedUser: User;
  deletedAt?: string;
  deletedUsername?: string;
  deletedUser?: User;
  projectId: string;
  customerId: string;
  visitType: string;
  visitedUsername: string;
  visitedUser: User;
  visitedAt: string;
  description: string;
  visitedResult: string;
}

export default interface GetOutbound {
  projectId: string;
  project: Project;
  customerId: string;
  customer: Customer;
  ownerUsername: string;
  ownerUser: User;
  description: string;
  createdAt: string;
  createUsername: string;
  createdUser: User;
  updatedAt: string;
  updatedUsername: string;
  updatedUser: User;
  lastVisitedUsername: string;
  lastVisitedUser: User;
  lastVisitedAt: string;
  lastVisitedResult: string;
  introducedAt: string;
  quotedAt: string;
  negotiatedAt: string;
  signedAt: string;
  closedAt: string;
  callCount: number;
  nextCallAfter: string;
  callStatus: number;
  VisitRecords: VisitRecord[];
}