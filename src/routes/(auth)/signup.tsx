import { useEffect, useState } from 'react';

import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { CircleArrowLeft, X } from 'lucide-react';

import AuthContent from '@/features/auth/components/auth-content';
import AuthFooter from '@/features/auth/components/auth-footer';
import RotatingQuotes from '@/features/auth/components/rotating-quotes';
import SignupForm from '@/features/auth/components/signup-form';
import { authClient } from '@/lib/auth-client';

export const Route = createFileRoute('/(auth)/signup')({
  component: SignupPage,
});

function SignupPage() {
  const [page, setPage] = useState(1);
  const navigate = useNavigate();
  const { data: session } = authClient.useSession();
  const [reduceMotion, setReduceMotion] = useState(false);

  useEffect(() => {
    if (session?.user?.id) {
      navigate({ to: '/home', replace: true });
    }
  }, [session, navigate]);

  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReduceMotion(mq.matches);
    const handler = (e: MediaQueryListEvent) => setReduceMotion(e.matches);
    mq.addEventListener?.('change', handler);
    return () => mq.removeEventListener?.('change', handler);
  }, []);

  function handleClick() {
    setPage(1);
  }

  return (
    <>
      {!reduceMotion && (
        <div
          aria-hidden={true}
          className="signup-animated-mesh absolute top-0 right-0 bottom-0 left-0 m-auto h-1/2 w-1/2"
        />
      )}
      <div
        aria-hidden={true}
        className="absolute top-0 left-0 z-0 size-full bg-black/75 backdrop-blur-3xl"
      />
      <main className="relative flex h-full flex-col items-center justify-center">
        <Link
          to="/"
          aria-label="Close and go to home"
          className="text-foreground absolute top-2 left-2 rounded-full bg-white/[0.03] p-1 transition-colors duration-200 hover:bg-white/5 md:top-8"
        >
          <X size={18} />
        </Link>

        <div className={`mb-24 h-12 ${page === 2 ? 'block' : 'hidden'}`}>
          <RotatingQuotes />
        </div>

        <div className="animate-fade-in">
          <div className="relative bottom-[70px]">
            {page === 1 && (
              <AuthContent
                title="Welcome to FrameRate"
                description="Thank you for being an early adopter. Let's set up your account."
              />
            )}

            <section>
              {page === 2 && (
                <button
                  type="button"
                  onClick={handleClick}
                  className="text-gray hover:text-foreground mb-4 w-fit transition-colors duration-200"
                >
                  <CircleArrowLeft size={32} strokeWidth={1.1} />
                </button>
              )}
              <SignupForm page={page} setPage={setPage} />
            </section>
          </div>
        </div>
      </main>

      <AuthFooter
        text="Already have an account?"
        linkText="Login"
        linkTo="/login"
      />
    </>
  );
}
