#!/usr/bin/env python3
"""
Generate a self-signed certificate and private key for the livestream server.

Writes PEM files by default to ../echo/cert.crt and ../echo/key.key (paths
expected by `livestream_server.py`). The certificate will include SANs for
localhost, 127.0.0.1 and ::1 so the browser can connect to those origins.

Usage (from the livestream folder):
  python generate_cert.py
  python generate_cert.py --cert ../echo/cert.crt --key ../echo/key.key --hosts localhost 127.0.0.1 ::1
"""
import argparse
import os
import ipaddress
from datetime import datetime, timedelta

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.hazmat.backends import default_backend
from cryptography.x509.oid import NameOID


def generate_cert(hosts, cert_file, key_file, days):
    # Ensure output directory exists
    os.makedirs(os.path.dirname(os.path.abspath(cert_file)), exist_ok=True)
    os.makedirs(os.path.dirname(os.path.abspath(key_file)), exist_ok=True)

    # Generate private key
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048, backend=default_backend())

    # Subject / issuer
    subject = issuer = x509.Name([
        x509.NameAttribute(NameOID.COMMON_NAME, hosts[0]),
    ])

    # SANs
    alt_names = []
    for h in hosts:
        try:
            ip = ipaddress.ip_address(h)
            alt_names.append(x509.IPAddress(ip))
        except ValueError:
            alt_names.append(x509.DNSName(h))

    san = x509.SubjectAlternativeName(alt_names)

    cert = (
        x509.CertificateBuilder()
        .subject_name(subject)
        .issuer_name(issuer)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(datetime.utcnow() - timedelta(minutes=5))
        .not_valid_after(datetime.utcnow() + timedelta(days=days))
        .add_extension(san, critical=False)
        .sign(key, hashes.SHA256(), default_backend())
    )

    # Write key
    with open(key_file, 'wb') as f:
        f.write(
            key.private_bytes(
                encoding=serialization.Encoding.PEM,
                format=serialization.PrivateFormat.TraditionalOpenSSL,
                encryption_algorithm=serialization.NoEncryption(),
            )
        )

    # Write cert
    with open(cert_file, 'wb') as f:
        f.write(cert.public_bytes(serialization.Encoding.PEM))

    print(f'Wrote cert -> {cert_file}')
    print(f'Wrote key  -> {key_file}')


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--hosts', '-H', nargs='+', default=['localhost', '127.0.0.1', '::1'],
                        help='Hostnames or IPs to include in the certificate SANs')
    parser.add_argument('--cert', default='../echo/cert.crt', help='Output cert filename (PEM)')
    parser.add_argument('--key', default='../echo/key.key', help='Output key filename (PEM)')
    parser.add_argument('--days', type=int, default=365, help='Days certificate is valid for')
    args = parser.parse_args()

    generate_cert(args.hosts, args.cert, args.key, args.days)
