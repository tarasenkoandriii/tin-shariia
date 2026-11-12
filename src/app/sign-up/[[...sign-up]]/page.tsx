import { SignUp } from '@clerk/nextjs';

export default function Register() {
  return <main><h1>Створення облікового запису</h1><SignUp fallbackRedirectUrl="/invite" /></main>;
}
