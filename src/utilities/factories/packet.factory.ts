import {PaddingFrame} from '../../frame/padding';
import {Stream} from '../../quicker/stream';
import {Connection} from '../../quicker/connection';
import {PacketNumber, Version} from '../../packet/header/header.properties';
import {VersionNegotiationPacket} from '../../packet/packet/version.negotiation';
import {LongHeader, LongHeaderType} from '../../packet/header/long.header';
import {Constants} from '../constants';
import {InitialPacket} from '../../packet/packet/initial';
import {FrameType} from '../../frame/base.frame';
import {StreamFrame} from '../../frame/stream';
import {CryptoFrame} from '../../frame/crypto';
import {Bignum} from '../../types/bignum';
import {RetryPacket} from '../../packet/packet/retry';
import {BaseFrame} from '../../frame/base.frame';
import {HandshakePacket} from '../../packet/packet/handshake';
import { ShortHeaderPacket } from '../../packet/packet/short.header.packet';
import { ShortHeader, ShortHeaderType } from '../../packet/header/short.header';
import { TransportParameterType } from '../../crypto/transport.parameters';
import { EndpointType } from '../../types/endpoint.type';
import { Protected0RTTPacket } from '../../packet/packet/protected.0rtt';
import { VersionNegotiationHeader } from '../../packet/header/version.negotiation.header';



export class PacketFactory {

    /**
     *  Method to create a Version Negotiation packet, given the connection
     * 
     * @param connection
     */
    public static createVersionNegotiationPacket(connection: Connection): VersionNegotiationPacket {
        var version = new Version(Buffer.from('00000000', 'hex'));
        // is only created by a server in response to a client that had an unsupported version in its ClientInitial packet
        // destConnectionID must be the srcID the client wanted (is in getDestConnectionID, as expected)
        // srcConnectionID must echo the random value the client choose for us, so NO CUSTOM GENERATED VALUE
        // for some reason, in our implementation, we get that client-generated value from getInitialDestConnectionID (which is correct, in theory, but quite difficult to reason about)
        // REFACTOR TODO: maybe rename the initialDestConnectionID to something that more clearly describes its goal at the server? or make a separate var for this? 
        // https://tools.ietf.org/html/draft-ietf-quic-transport#section-4.3
        var header = new VersionNegotiationHeader(Math.floor((Math.random() * 128)), connection.getDestConnectionID(), connection.getInitialDestConnectionID());
        var versions: Version[] = [];
        Constants.SUPPORTED_VERSIONS.forEach((version: string) => {
            versions.push(new Version(Buffer.from(version, 'hex')));
        });
        return new VersionNegotiationPacket(header, versions);
    }

    /**
     *  Method to create a Client Initial packet, given the connection object and frames
     * 
     * @param connection
     */
    public static createInitialPacket(connection: Connection, frames: BaseFrame[]): InitialPacket {
        // clientInitial: no real destination conn id known
        // serverInitial: we know our own src and the client's dest
        let dstConnectionID = connection.getDestConnectionID() === undefined ? connection.getInitialDestConnectionID() : connection.getDestConnectionID();

        var header = new LongHeader(LongHeaderType.Initial, dstConnectionID, connection.getSrcConnectionID(), new PacketNumber(0), new Bignum(0), connection.getVersion());
        var initial = new InitialPacket(header, frames);

        // for security purposes, we want our initial packet to always be the exact same size (1280 bytes)
        // so we add PADDING frames to reach that size if the encrypted initial packet isn't long enough. 
        // https://tools.ietf.org/html/draft-ietf-quic-transport#section-4.4.1
        var size = initial.getSize();
        if( initial.getFrames()[0].getType() == FrameType.CRYPTO ){
            let crypto = <CryptoFrame> initial.getFrames()[0];
            console.log("Creating Initial packet, Longheader + Crypto size was ", size, crypto.toBuffer().byteLength, crypto.getLength(), crypto.getData().byteLength);
        }
        // TODO: it's also allowed to fill this with 0-RTT request, which we currently don't support, but which would be much better!
        if (size < Constants.INITIAL_MIN_SIZE) {
            var padding = new PaddingFrame(Constants.INITIAL_MIN_SIZE - size);

            console.log("Creating padding frame of size ", padding.getLength());
            initial.getFrames().push(padding);
        }
        header.setPayloadLength(initial.getFrameSizes() + Constants.DEFAULT_AEAD_LENGTH);
        return initial;
    }

    /**
     *  Method to create a Server Stateless Retry Packet, given the connection
     * 
     * @param connection
     */
    public static createRetryPacket(connection: Connection, frames: BaseFrame[]): RetryPacket {
        // UPDATE-12 TODO: packet number of a retry packet MUST be set to zero https://tools.ietf.org/html/draft-ietf-quic-transport#section-4.4.2
        var header = new LongHeader(LongHeaderType.Retry, connection.getDestConnectionID(), connection.getInitialDestConnectionID(), new PacketNumber(0), new Bignum(-1), connection.getVersion());
        return new RetryPacket(header, frames);
    }

    /**
     *  Method to create a Handshake Packet, given the connection object and frames
     * 
     * @param connection 
     * @param frames 
     */
    public static createHandshakePacket(connection: Connection, frames: BaseFrame[]): HandshakePacket {
        var dstConnectionID = connection.getDestConnectionID() === undefined ? connection.getInitialDestConnectionID() : connection.getDestConnectionID();
        var header = new LongHeader(LongHeaderType.Handshake, dstConnectionID, connection.getSrcConnectionID(), new PacketNumber(-1), new Bignum(-1), connection.getVersion());
        var packet = new HandshakePacket(header, frames);
        header.setPayloadLength(packet.getFrameSizes() + Constants.DEFAULT_AEAD_LENGTH);
        return packet;
    }

    public static createProtected0RTTPacket(connection: Connection, frames: BaseFrame[]): Protected0RTTPacket {
        // UPDATE-12 TODO: new packet number encryption setup is needed here + extra protection
        // https://tools.ietf.org/html/draft-ietf-quic-transport-12#section-4.5
        var header = new LongHeader(LongHeaderType.Protected0RTT, connection.getInitialDestConnectionID(), connection.getSrcConnectionID(), new PacketNumber(-1), new Bignum(-1), connection.getVersion());
        var packet = new Protected0RTTPacket(header, frames);
        header.setPayloadLength(packet.getFrameSizes() + Constants.DEFAULT_AEAD_LENGTH);
        return packet;
    }

    /**
     *  Method to create a ShortHeader Packet, given the connection object and frames
     * TODO: dynamic shortheader type and keyphasebit
     * @param connection 
     * @param frames 
     */
    public static createShortHeaderPacket(connection: Connection, frames: BaseFrame[]): ShortHeaderPacket {
        var header = new ShortHeader(ShortHeaderType.FourOctet, connection.getDestConnectionID(), new PacketNumber(-1), false, connection.getSpinBit());
        return new ShortHeaderPacket(header, frames);
    }
}