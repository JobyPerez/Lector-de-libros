type RabbitMarkProps = {
  className?: string;
  title?: string;
};

export function RabbitMark({ className, title }: RabbitMarkProps) {
  return (
    <svg
      aria-hidden={title ? undefined : true}
      className={className}
      fill="none"
      role={title ? "img" : undefined}
      viewBox="0 0 96 96"
      xmlns="http://www.w3.org/2000/svg"
    >
      {title ? <title>{title}</title> : null}
      <circle cx="48" cy="48" fill="url(#rabbitGradient)" r="46" />
      <path d="M32 22C32 13.7157 37.3726 7 44 7C50.6274 7 56 13.7157 56 22V38H32V22Z" fill="#FFF4D6" />
      <path d="M46 18C46 10.268 50.9249 4 57 4C63.0751 4 68 10.268 68 18V39H46V18Z" fill="#FFE8B3" />
      <path d="M61 39C72.598 39 82 48.402 82 60C82 71.598 72.598 81 61 81H37C25.402 81 16 71.598 16 60C16 48.402 25.402 39 37 39H61Z" fill="#FFF9EE" />
      <ellipse cx="36.5" cy="56" fill="#294F3D" rx="3.5" ry="4.5" />
      <ellipse cx="59.5" cy="56" fill="#294F3D" rx="3.5" ry="4.5" />
      <path d="M48 58C50.7614 58 53 60.2386 53 63V63C53 65.7614 50.7614 68 48 68V68C45.2386 68 43 65.7614 43 63V63C43 60.2386 45.2386 58 48 58V58Z" fill="#DD8B54" />
      <path d="M39 69C42.1223 72.0723 44.9386 73.5 48 73.5C51.0614 73.5 53.8777 72.0723 57 69" stroke="#B26734" strokeLinecap="round" strokeWidth="3.5" />
      <defs>
        <linearGradient id="rabbitGradient" x1="16" x2="80" y1="10" y2="88" gradientUnits="userSpaceOnUse">
          <stop stopColor="#204436" />
          <stop offset="0.55" stopColor="#3E6D4A" />
          <stop offset="1" stopColor="#D98841" />
        </linearGradient>
      </defs>
    </svg>
  );
}