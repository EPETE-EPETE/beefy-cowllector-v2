export function bigintPercent(n: bigint, percent: number, precision: number = 4) {
    // round to precision
    const divisor = 10 ** precision;
    const mult = BigInt(Math.round(percent * divisor));
    return (n * mult) / BigInt(divisor);
}

export function bigintFormat(n: bigint, decimal: number): string {
    const sign = n < 0 ? '-' : '';
    n = n < 0 ? -n : n;
    const div = BigInt(10 ** decimal);
    const decimalPart = (n % div).toString().padStart(decimal, '0');
    const integerPart = (n / div).toString();
    return `${sign}${integerPart}.${decimalPart}`;
}
