type RabbitMarkProps = {
  className?: string;
  title?: string;
};

const rabbitMarkSrc = `${import.meta.env.BASE_URL}conejo-lector-mark.jpg`;

export function RabbitMark({ className, title }: RabbitMarkProps) {
  return (
    <img
      alt={title ?? ""}
      aria-hidden={title ? undefined : true}
      className={className}
      decoding="async"
      draggable={false}
      src={rabbitMarkSrc}
    />
  );
}