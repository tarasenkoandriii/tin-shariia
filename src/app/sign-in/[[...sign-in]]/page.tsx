import { SignIn } from '@clerk/nextjs';

export default function Login() {
  return <main><h1>Вхід до редакції</h1><SignIn fallbackRedirectUrl="/editorial" /></main>;
}
